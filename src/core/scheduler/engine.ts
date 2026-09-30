/**
 * Scheduler engine — computes nextRunAt for any ScheduleSpec, owns the
 * in-memory task cache, and runs a setTimeout-based dispatcher per scope.
 *
 * Architecture:
 *   - One SchedulerEngine instance per scope (main, each workspace).
 *   - On start: load tasks.json, for each enabled task compute nextRunAt,
 *     schedule a setTimeout for the soonest fire, and re-schedule on tick.
 *   - On tick: lock the task (avoid re-entry), emit SCHEDULED_TASK_FIRED,
 *     dispatch to the facade (facade.prompt), wait for completion, persist
 *     the run record, and (if recurring) compute nextRunAt and schedule
 *     again. If endAt has passed, mark the task disabled.
 *   - tasks.json is watched: tasks written by OTHER processes (e.g. a task
 *     created for this workspace from a different window's sidecar) are
 *     diff-merged into memory and scheduled without a restart.
 *   - API: load / reload / create / update / delete / runNow — all mutate
 *     in-memory cache and atomically rewrite tasks.json.
 *
 * Concurrency model:
 *   - Single Node.js process ⇒ setTimeout + JS event loop, so there's no
 *     thread-safety hazard per se. But we guard each task with a `running`
 *     flag so an overlap (e.g. clock skew, manual run-now during scheduled
 *     fire) can't double-dispatch.
 *
 * Event emission:
 *   - All events are written to stdout by the RPC layer (engine doesn't
 *     know about stdout). The engine returns an event emitter-like object
 *     that callers (rpc-mode.ts) can subscribe to.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import type { ConcurrencyPolicy, ScheduledTask, ScheduledTaskSummary, ScheduledTaskRun, SessionTarget } from "@zharness/protocol";
import { SessionLockManager, type AcquireResult } from "./locks.js";
import { cronNextRun } from "./cron.js";
import { defaultTaskName, generateTaskId, validateScheduleSpec } from "./types.js";
import {
	appendRun,
	getSchedulerDir,
	readRuns,
	readTaskFreshChecked,
	readTasks,
	readTasksChecked,
	recoverTasksFile,
	writeTasks,
} from "./store.js";
import { SchedulerScopeLock, STALE_MS, readLiveHolder } from "./scope-lock.js";

/**
 * True when some live process owns this scope's dispatch loop (scope-lock
 * holder alive + heartbeat fresh). The RPC layer uses it to tell "fired"
 * from "queued until the owning sidecar opens" for cross-scope run-now.
 */
export function isScopeEngineAlive(scope: "main" | "workspace", workspaceId?: string): boolean {
	try {
		return readLiveHolder(getSchedulerDir(scope, workspaceId)) !== null;
	} catch {
		// getSchedulerDir throws for workspace scope without workspaceId —
		// no owner can be alive for a scope that cannot be addressed.
		return false;
	}
}

/**
 * Node's setTimeout clamps delays above 2^31-1 ms (~24.8 days) to 1ms.
 * Waits longer than this are chunked: sleep MAX_TIMEOUT_MS, then recompute
 * the remaining delay (scheduleOne re-entry).
 */
const MAX_TIMEOUT_MS = 2_147_000_000; // just under 2^31-1, ~24.85 days

/**
 * fireTask refuses fires that arrive more than this many ms before their
 * scheduled time — a timer that somehow fired early (clock jump, clamped
 * overflow on an old build) reschedules instead of running the task early.
 */
const EARLY_FIRE_TOLERANCE_MS = 60_000;

/** Debounce for tasks.json watcher events before the diff-merge sync runs. */
const TASKS_SYNC_DEBOUNCE_MS = 300;
/** Safety poll interval for discovering external tasks.json writes. */
const TASKS_SYNC_POLL_MS = 30_000;

// --- nextRunAt: the heart of the engine -------------------------------------

/**
 * Compute the next fire time for a task at or after `from` (epoch ms).
 * Returns null if the schedule can no longer fire (endAt passed, disabled,
 * or no future match within reason).
 */
export function nextRunAt(task: ScheduledTask, from: number = Date.now()): number | null {
	if (!task.enabled) return null;
	const endAt = task.schedule.endAt;
	if (typeof endAt === "number" && endAt <= from) return null;

	const startAt = task.schedule.startAt ?? task.createdAt;
	const base = Math.max(from, startAt);

	const spec = task.schedule;
	switch (spec.mode) {
		case "every_n_minutes": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			// Align to N-minute boundaries in UTC.
			const intervalMs = n * 60_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "every_n_hours": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			const intervalMs = n * 3600_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "daily":
		case "weekdays":
		case "weekly":
		case "monthly": {
			const times = (spec.times ?? []).slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
			if (times.length === 0) return null;
			return nextForDateAnchoredSchedule(spec.mode, times, spec.weekdays ?? null, spec.daysOfMonth ?? null, base, endAt);
		}
		case "cron": {
			if (!spec.cron?.expression) return null;
			// A hand-edited / foreign tasks.json can carry an expression that
			// parseCron rejects. One bad expression must never throw out of
			// nextRunAt — that would kill engine.load() (whole scope stops
			// dispatching) and blow up schedule_list. Treat as unschedulable.
			try {
				const next = cronNextRun(spec.cron.expression, base);
				if (next === null) return null;
				if (typeof endAt === "number" && next > endAt) return null;
				return next;
			} catch {
				return null;
			}
		}
		case "once": {
			// 单次:只在 startAt(缺省为创建时间)触发一次;触发过或已过点
			// 则不再有下次运行——UI 据此把 runCount>0 的单次任务显示为「非定时」。
			// 尚未跑过(runCount=0)时即使 fireAt 已过也立即触发:否则
			// 无 startAt 的任务在 create→scheduleOne 的毫秒级间隙里
			// fireAt 就已落后于 now,nextRunAt 永远返回 null,任务永不触发;
			// 触发瞬间应用恰好关闭/重启的场景也依赖这一兜底补跑。
			// 边界用 <=:定时器恰好在 fireAt 这一刻触发时,from === fireAt,
			// 严格小于会让已跑过的任务再次拿到 fireAt → 立即重排 → 同一
			// 毫秒内连环重复派发(dispatch 足够快时每毫秒一次)。
			const fireAt = typeof spec.startAt === "number" ? spec.startAt : task.createdAt;
			if (fireAt <= from && (task.runCount ?? 0) > 0) return null;
			if (typeof endAt === "number" && fireAt > endAt) return null;
			return fireAt;
		}
		default:
			return null;
	}
}

function nextForDateAnchoredSchedule(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	times: Array<{ hour: number; minute: number }>,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
	base: number,
	endAt: number | undefined,
): number | null {
	// We scan forward at most 366 days.
	const horizon = base + 366 * 24 * 3600_000;
	const baseDate = new Date(base);

	// Start scanning from the beginning of the base minute.
	let candidate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), baseDate.getHours(), baseDate.getMinutes(), 0, 0).getTime();
	// Always look strictly AFTER `base`, so bump by 1 minute if equal.
	if (candidate <= base) candidate += 60_000;

	while (candidate <= horizon) {
		if (typeof endAt === "number" && candidate > endAt) return null;
		const d = new Date(candidate);
		if (matchesDateMode(mode, d, weekdays, daysOfMonth)) {
			for (const t of times) {
				if (t.hour === d.getHours() && t.minute === d.getMinutes()) {
					return candidate;
				}
			}
		}
		candidate += 60_000; // 1-minute step is fine: max 366*24*60 = ~530k iterations
	}
	return null;
}

function matchesDateMode(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	d: Date,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
): boolean {
	const day = d.getDay(); // 0=Sun..6=Sat
	const date = d.getDate();
	switch (mode) {
		case "daily":
			return true;
		case "weekdays":
			return day >= 1 && day <= 5;
		case "weekly":
			return weekdays?.includes(day) ?? false;
		case "monthly":
			return daysOfMonth?.includes(date) ?? false;
	}
}

/**
 * Compute the next N fire times for preview / display purposes. Stops early
 * if endAt is set. Pure function — does not touch task state.
 */
export function nextNRuns(task: ScheduledTask, n: number, from: number = Date.now()): number[] {
	const out: number[] = [];
	let cursor = from;
	for (let i = 0; i < n; i++) {
		const next = nextRunAt({ ...task, lastRunAt: cursor }, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next + 60_000;
	}
	return out;
}

// --- SchedulerEngine -------------------------------------------------------

export interface SchedulerEngineEvents {
	"task.fired": (taskId: string, eventId: string | undefined, sessionId: string) => void;
	"task.completed": (run: ScheduledTaskRun) => void;
}

export type SchedulerListener = (event: { type: keyof SchedulerEngineEvents; payload: unknown }) => void;

export interface Dispatcher {
	/**
	 * Dispatch the task's prompt to the agent. Implementations typically
	 * call `facade.prompt(prompt)`. The returned promise resolves when the
	 * turn is complete (or rejects on error). The eventId of the produced
	 * USER_MESSAGE event (if any) and the sessionId the prompt landed in
	 * should be returned.
	 *
	 * The lock acquired on the session (if any) is held for the lifetime
	 * of this promise. The engine calls release() once the promise settles.
	 */
	dispatch(task: ScheduledTask): Promise<{ eventId?: string; sessionId?: string; error?: string }>;
	/**
	 * Abort the in-flight turn for `taskId`. Called when the lock times
	 * out or when a "preempt" policy is firing off the current holder.
	 * The dispatcher should best-effort abort any active turn and resolve
	 * promptly; the engine then releases the lock and records a failed
	 * run with reason: "timeout".
	 */
	abort?(taskId: string): void;
}

export interface SchedulerEngineOptions {
	scope: "main" | "workspace";
	workspaceId?: string;
	dispatcher: Dispatcher;
	listener?: SchedulerListener;
	/** For tests: deterministic clock. Defaults to Date.now. */
	now?: () => number;
}

/**
 * True when the task's session target can never dispatch in any engine
 * (legacy "current" targets awaiting migration). Exported so the RPC layer
 * can reject cross-scope run-now requests with the same rule as runNow.
 */
export function unsupportedSessionTargetReason(task: ScheduledTask): string | null {
	const target = task.sessionTarget;
	if (!target || target.kind === "current") {
		return "legacy current session target requires migration";
	}
	// pinned without sessionId: created cross-scope (e.g. the GUI wrote the
	// task from a window whose sidecar doesn't serve this scope, so it could
	// not backfill its own active session). The dispatcher falls back to the
	// sidecar's active session at fire time and fireTask pins the resolved
	// session afterwards — the task MUST stay schedulable (it used to be
	// silently dropped here, which is why project tasks never fired).
	return null;
}

export class SchedulerEngine {
	private readonly scope: "main" | "workspace";
	private readonly workspaceId: string | undefined;
	private readonly dispatcher: Dispatcher;
	private readonly listener: SchedulerListener | undefined;
	private readonly now: () => number;
	private tasks: Map<string, ScheduledTask> = new Map();
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private running: Set<string> = new Set();
	private recordedByTimeout: Set<string> = new Set();
	/** Per-session mutex for scheduled tasks. */
	private locks = new SessionLockManager();
	/** One sidecar has one runtime, and that runtime can process one prompt at a time. */
	private runtimeQueue: Promise<void> = Promise.resolve();
	/** Cached actual session id from the dispatcher for diagnostics. */
	private currentSessionId: string | undefined;
	/**
	 * Ids this engine has ever loaded/created/deleted. persist() uses it to
	 * distinguish externally-added tasks (unknown ids on disk — preserve) from
	 * our own stale copies (known ids — our memory is authoritative).
	 */
	private knownIds: Set<string> = new Set();
	private emitter = new EventEmitter();
	private stopped = false;
	/** Tracks whether the engine has been disposed. */
	private disposed = false;
	/**
	 * Cross-process singleton guard. Only the lock holder schedules timers;
	 * passive engines still serve CRUD (writes land in tasks.json and the
	 * active engine re-reads the file before each fire).
	 */
	private scopeLock: SchedulerScopeLock;
	/** True when another live process owns this scope's dispatch loop. */
	private passive = false;
	/** Passive-mode retry: periodically re-attempt the scope lock takeover. */
	private reacquireTimer: NodeJS.Timeout | undefined;
	/**
	 * Watcher on tasks.json so externally-written tasks (e.g. created by a
	 * different sidecar via the store layer, for a scope this process doesn't
	 * serve) are discovered and scheduled without a restart. Without it, a
	 * task created for an already-running project window never fires.
	 */
	private tasksWatcher: FSWatcher | undefined;
	/** Safety poll for platforms where fs.watch is unavailable/broken. */
	private syncPollTimer: NodeJS.Timeout | undefined;
	/** Debounce for watcher/poll → syncFromDisk. */
	private syncDebounce: NodeJS.Timeout | undefined;

	constructor(opts: SchedulerEngineOptions) {
		this.scope = opts.scope;
		this.workspaceId = opts.workspaceId;
		this.dispatcher = opts.dispatcher;
		this.listener = opts.listener;
		this.now = opts.now ?? Date.now;
		// When the lock times out (or is preempted), abort the in-flight turn
		// and record a "timeout" run row. The actual lock release + record
		// append happens in fireTask's finally block (or release() in the
		// queue/preempt paths) so the bookkeeping is consistent.
		this.locks.onTimeout = (taskId, sessionId) => {
			this.handleTimeout(taskId, sessionId);
		};
		this.scopeLock = new SchedulerScopeLock(getSchedulerDir(this.scope, this.workspaceId), this.now);
		// If the heartbeat discovers another process took the lock over (e.g.
		// this process was suspended long enough to look dead), demote to
		// passive: cancel all timers so we never double-dispatch against the
		// new owner. CRUD keeps working (writes land in tasks.json).
		this.scopeLock.onLost = () => {
			if (this.disposed || this.passive) return;
			this.passive = true;
			for (const t of this.timers.values()) clearTimeout(t);
			this.timers.clear();
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""} lock lost to pid ${this.scopeLock.holderPid()}; demoted to passive`,
			);
			this.startPassiveReacquire();
		};
	}

	// --- lifecycle ---

	/** Load tasks from disk and schedule all enabled ones. */
	load(): void {
		if (this.disposed) return;
		const stored = readTasks(this.scope, this.workspaceId);
		this.tasks.clear();
		for (const t of stored) {
			this.tasks.set(t.id, t);
			this.knownIds.add(t.id);
		}
		// Discover external writes (tasks created for this scope by another
		// sidecar while we run) from here on.
		this.startTasksWatcher();
		// Cross-process guard: if another live process already dispatches for
		// this scope, stay passive — no timers, no double-fire. CRUD is still
		// served from this engine and lands in tasks.json.
		if (!this.scopeLock.tryAcquire()) {
			this.passive = true;
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""} is owned by pid ${this.scopeLock.holderPid()}; running passive (no dispatch)`,
			);
			this.startPassiveReacquire();
			return;
		}
		this.passive = false;
		this.scheduleAll();
		this.catchUpMissedRuns();
		// 引擎启动前落盘的跨进程「立即运行」请求(任务属于本 scope,但写入时
		// 拥有方 sidecar 尚未运行)在此补跑。
		this.consumeRunRequests([...this.tasks.values()]);
	}

	/**
	 * Watch the scheduler dir for tasks.json changes (cross-process writes by
	 * other sidecars via the store layer) plus a low-frequency safety poll.
	 * Both funnel into the debounced diff-merge syncFromDisk.
	 */
	private startTasksWatcher(): void {
		if (this.disposed || this.tasksWatcher || this.syncPollTimer) return;
		const dir = getSchedulerDir(this.scope, this.workspaceId);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			/* readTasks tolerates a missing dir; the poll below still runs */
		}
		try {
			this.tasksWatcher = watch(dir, (_event, filename) => {
				if (filename && !String(filename).split(/[\\/]/).pop()!.startsWith("tasks.json")) return;
				this.scheduleSyncFromDisk();
			});
			this.tasksWatcher.on("error", () => {
				// Broken watcher: fall back to the safety poll only.
				this.stopTasksWatcher();
				this.startSyncPoll();
			});
			this.tasksWatcher.on("close", () => {
				this.tasksWatcher = undefined;
			});
			this.tasksWatcher.unref?.();
		} catch {
			this.tasksWatcher = undefined;
		}
		this.startSyncPoll();
	}

	/** Low-frequency safety poll — cheap (tasks.json is tiny) and covers
	 * platforms / edge cases where directory events never arrive. */
	private startSyncPoll(): void {
		if (this.disposed || this.syncPollTimer) return;
		this.syncPollTimer = setInterval(() => this.scheduleSyncFromDisk(), TASKS_SYNC_POLL_MS);
		this.syncPollTimer.unref?.();
	}

	private stopTasksWatcher(): void {
		if (this.syncPollTimer) {
			clearInterval(this.syncPollTimer);
			this.syncPollTimer = undefined;
		}
		if (this.tasksWatcher) {
			try {
				this.tasksWatcher.close();
			} catch {
				/* best-effort */
			}
			this.tasksWatcher = undefined;
		}
		if (this.syncDebounce) {
			clearTimeout(this.syncDebounce);
			this.syncDebounce = undefined;
		}
	}

	/** Debounced entry: coalesce watcher bursts (atomic writes rename twice). */
	private scheduleSyncFromDisk(): void {
		if (this.disposed) return;
		if (this.syncDebounce) return;
		this.syncDebounce = setTimeout(() => {
			this.syncDebounce = undefined;
			this.syncFromDisk();
		}, TASKS_SYNC_DEBOUNCE_MS);
		this.syncDebounce.unref?.();
	}

	/**
	 * Diff-merge tasks.json into memory so external writes take effect live:
	 *   - unknown ids on disk → adopt + schedule (cross-process create);
	 *   - ids missing on disk → drop + cancel timer (cross-process delete —
	 *     also prevents our next persist() from resurrecting them);
	 *   - disk copy newer than memory (external pause/resume/patch) → adopt
	 *     and reschedule.
	 * Our own writes never trigger a diff (persist() writes memory to disk),
	 * and in-flight fires are unaffected: their run record is only written
	 * after dispatch settles, and fireTask re-reads the task fresh anyway.
	 */
	private syncFromDisk(): void {
		if (this.disposed) return;
		// A corrupt / locked file is NOT "all tasks deleted" — keep memory as
		//-is and retry on the next watcher event / poll.
		const disk = readTasksChecked(this.scope, this.workspaceId);
		if (!disk.ok) {
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""}: tasks.json unreadable, skipping sync`,
			);
			return;
		}
		const onDisk = disk.tasks;
		const byId = new Map(onDisk.map((t) => [t.id, t] as const));
		for (const id of [...this.tasks.keys()]) {
			if (byId.has(id)) continue;
			this.cancelTimer(id);
			this.tasks.delete(id);
		}
		for (const t of onDisk) {
			const known = this.tasks.get(t.id);
			if (!known) {
				this.tasks.set(t.id, t);
				this.knownIds.add(t.id);
				this.scheduleOne(t);
			} else if ((t.updatedAt ?? 0) > (known.updatedAt ?? 0)) {
				this.cancelTimer(t.id);
				this.tasks.set(t.id, t);
				if (t.enabled) this.scheduleOne(t);
			}
		}
		// 跨进程「立即运行」:磁盘上新写入的 runRequestedAt 标记由本 scope 的
		// 活跃持有方补触发;被动引擎不得消费(它不派发,活跃方会经自己的
		// watcher 看到并触发,双方都消费会重复跑)。
		if (!this.passive) {
			this.consumeRunRequests(onDisk.filter((t) => typeof t.runRequestedAt === "number"));
		}
	}

	/**
	 * 补跑跨进程「立即运行」请求:runRequestedAt 标记由服务其他 scope 的
	 * sidecar 写入 tasks.json(本进程无法替它派发,见 ScheduledTask.
	 * runRequestedAt)。拥有该 scope 的引擎发现标记即视为一次手动触发:
	 * 先清除标记并落盘,再走 runNow 的同一套校验与派发。标记可能写在基于
	 * 旧状态的文件上,内存副本更新时以内存为底清除,避免回退本地改动。
	 */
	private consumeRunRequests(tasks: ScheduledTask[]): void {
		for (const disk of tasks) {
			if (typeof disk.runRequestedAt !== "number") continue;
			const memory = this.tasks.get(disk.id);
			const base = memory && (memory.updatedAt ?? 0) >= (disk.updatedAt ?? 0) ? memory : disk;
			const consumed: ScheduledTask = { ...base };
			delete consumed.runRequestedAt;
			this.tasks.set(disk.id, consumed);
			this.knownIds.add(disk.id);
			this.persist();
			// 先清标记后触发:清标记与触发之间崩溃最多丢一次补跑,不会重复触发。
			void this.runNow(disk.id).then((r) => {
				if (!r.ok) {
					console.warn(
						`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""}: pending run-request for task ${disk.id} dropped: ${r.error}`,
					);
				}
			});
		}
	}

	/**
	 * While passive, periodically re-attempt the scope lock. The active
	 * holder may die (crash, kill, suspend) without releasing `engine.lock`;
	 * without this retry the passive engine would never take over and every
	 * task in the scope would silently stop firing until an app restart.
	 * tryAcquire only succeeds once the holder's heartbeat goes stale
	 * (STALE_MS), so a healthy holder is never stolen from.
	 */
	private startPassiveReacquire(): void {
		if (this.reacquireTimer || this.disposed) return;
		this.reacquireTimer = setInterval(() => {
			if (this.disposed || !this.passive) return;
			if (!this.scopeLock.tryAcquire()) return;
			this.stopPassiveReacquire();
			this.passive = false;
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""} lock acquired; promoting from passive to active dispatch`,
			);
			// Full reload, not just scheduleAll: tasks created by the previous
			// holder while we were passive are not in this.tasks yet.
			this.load();
		}, STALE_MS);
		if (typeof (this.reacquireTimer as { unref?: () => void }).unref === "function") {
			(this.reacquireTimer as { unref: () => void }).unref();
		}
	}

	private stopPassiveReacquire(): void {
		if (this.reacquireTimer) {
			clearInterval(this.reacquireTimer);
			this.reacquireTimer = undefined;
		}
	}

	/**
	 * Force a re-read from disk. Returns the number of tasks now in memory.
	 * Useful when an external process edits tasks.json (e.g. the desktop
	 * bridge writing a task directly).
	 */
	reload(): number {
		this.load();
		return this.tasks.size;
	}

	/** Stop all timers; safe to call multiple times. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped = true;
		this.stopPassiveReacquire();
		this.stopTasksWatcher();
		for (const [, t] of this.timers) {
			clearTimeout(t);
		}
		this.timers.clear();
		this.locks.dispose();
		this.scopeLock.release();
		this.emitter.removeAllListeners();
	}

	/**
	 * Resolve the target session id for a task. Pinned tasks use their saved
	 * logical session id. For SessionTarget: new, the dispatcher creates a new
	 * session and reports its id back via dispatch().sessionId.
	 */
	private resolveTargetSessionId(task: ScheduledTask): string {
		const target = task.sessionTarget;
		if (!target) return `unsupported:${task.id}`;
		switch (target.kind) {
			case "pinned":
				// Pinned without sessionId (cross-scope created): the dispatcher
				// falls back to the sidecar's active session and reports it back;
				// the `pending:` placeholder is migrated to the real id after
				// dispatch (see fireTask).
				return target.sessionId ?? `pending:${task.id}`;
			case "current":
				return `unsupported:${task.id}`;
			case "new":
				// The dispatcher picks / creates the actual session id. We use a
				// deterministic placeholder for the lock key; the real id replaces
				// it after dispatch returns. This is fine because the lock is
				// held for the entire dispatch promise.
				return `pending:${task.id}`;
		}
	}

	/**
	 * Called by the lock manager when a task's timeout fires (or a preempt
	 * overwrites the holder). Aborts the in-flight turn (if any) and
	 * records a "timeout" run. The lock is released by the lock manager
	 * immediately after, so queued tasks can proceed.
	 */
	private handleTimeout(taskId: string, _sessionId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		try {
			this.dispatcher.abort?.(taskId);
		} catch {
			/* best-effort */
		}
		// Record the timeout run.
		const at = this.now();
		this.recordedByTimeout.add(taskId);
		const run: ScheduledTaskRun = {
			taskId,
			at,
			status: "failed",
			reason: task.timeoutMinutes && task.timeoutMinutes > 0
				? `timeout after ${task.timeoutMinutes}min`
				: "preempted by another task",
		};
		appendRun(this.scope, this.workspaceId, run);
		// Update the task's lastRun + runCount so the UI reflects reality.
		this.tasks.set(taskId, {
			...task,
			lastRunAt: at,
			lastRunStatus: "failed",
			updatedAt: this.now(),
			runCount: (task.runCount ?? 0) + 1,
		});
		this.persist();
		this.emit({ type: "task.completed", payload: run });
	}

	// --- task CRUD ---

	// --- task CRUD ---

	list(): ScheduledTaskSummary[] {
		const now = this.now();
		return Array.from(this.tasks.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((t) => this.summarize(t, now));
	}

	get(id: string): ScheduledTaskSummary | null {
		const t = this.tasks.get(id);
		if (!t) return null;
		return this.summarize(t, this.now());
	}

	create(input: {
		name: string;
		prompt: string;
		schedule: ScheduledTask["schedule"];
		enabled?: boolean;
		description?: string;
		createdBy?: "user" | "intent";
		sourceText?: string;
		startAt?: number;
		endAt?: number;
		sessionTarget?: SessionTarget;
		concurrencyPolicy?: ConcurrencyPolicy;
		timeoutMinutes?: number;
		maxRuns?: number;
	}): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const validation = validateScheduleSpec(input.schedule);
		if (validation) return { ok: false, error: validation };

		const now = this.now();
		const task: ScheduledTask = {
			id: generateTaskId(),
			name: input.name.trim() || defaultTaskName(input.prompt),
			prompt: input.prompt,
			scope: this.scope,
			workspaceId: this.workspaceId,
			schedule: input.schedule,
			enabled: input.enabled ?? true,
			description: input.description,
			createdAt: now,
			updatedAt: now,
			createdBy: input.createdBy ?? "user",
			sourceText: input.sourceText,
			runCount: 0,
			sessionTarget: input.sessionTarget,
			concurrencyPolicy: input.concurrencyPolicy,
			timeoutMinutes: input.timeoutMinutes,
			maxRuns: input.maxRuns,
		};
		// Persist schedule.endAt / startAt into the embedded schedule so the
		// nextRunAt helper reads a consistent shape. Fall back to the values
		// the caller already embedded in schedule — the GUI dialog puts the
		// once-mode fire time in schedule.startAt and leaves the top-level
		// fields unset; blindly assigning undefined here would silently wipe
		// the user's chosen time and the task would fire at createdAt instead.
		task.schedule = {
			...task.schedule,
			startAt: input.startAt ?? task.schedule.startAt,
			endAt: input.endAt ?? task.schedule.endAt,
		};

		this.tasks.set(task.id, task);
		this.knownIds.add(task.id);
		this.persist();
		this.scheduleOne(task);
		return { ok: true, task: this.summarize(task, now) };
	}

	update(
		id: string,
		patch: {
			name?: string;
			prompt?: string;
			schedule?: ScheduledTask["schedule"];
			enabled?: boolean;
			description?: string | null;
			startAt?: number | null;
			endAt?: number | null;
			sessionTarget?: SessionTarget | null;
			concurrencyPolicy?: ConcurrencyPolicy | null;
			timeoutMinutes?: number | null;
			maxRuns?: number | null;
		},
	): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const existing = this.tasks.get(id);
		if (!existing) return { ok: false, error: `Task not found: ${id}` };

		if (patch.schedule) {
			const validation = validateScheduleSpec(patch.schedule);
			if (validation) return { ok: false, error: validation };
		}

		// Build the new task. Filter patch to drop nulls (which mean "clear")
		// and apply the rest as overrides on top of existing.
		const filtered: Partial<ScheduledTask> = {};
		for (const [k, v] of Object.entries(patch)) {
			if (v === null) continue;
			(filtered as Record<string, unknown>)[k] = v;
		}
		const next: ScheduledTask = {
			...existing,
			...filtered,
			schedule: patch.schedule ?? existing.schedule,
			updatedAt: this.now(),
		};
		if (patch.startAt === null) delete next.schedule.startAt;
		else if (typeof patch.startAt === "number") next.schedule.startAt = patch.startAt;
		if (patch.endAt === null) delete next.schedule.endAt;
		else if (typeof patch.endAt === "number") next.schedule.endAt = patch.endAt;
		// Explicit clears: null = remove the field entirely.
		if (patch.description === null) delete next.description;
		if (patch.sessionTarget === null) delete next.sessionTarget;
		if (patch.concurrencyPolicy === null) delete next.concurrencyPolicy;
		if (patch.timeoutMinutes === null) delete next.timeoutMinutes;
		if (patch.maxRuns === null) delete next.maxRuns;

		this.tasks.set(id, next);
		this.persist();
		// Cancel and reschedule so changes take effect immediately.
		this.cancelTimer(id);
		if (next.enabled) this.scheduleOne(next);
		return { ok: true, task: this.summarize(next, this.now()) };
	}

	delete(id: string): { ok: true; id: string } | { ok: false; error: string } {
		if (!this.tasks.has(id)) return { ok: false, error: `Task not found: ${id}` };
		this.cancelTimer(id);
		this.tasks.delete(id);
		this.persist();
		return { ok: true, id };
	}

	/** Fire a task immediately, regardless of its schedule. */
	async runNow(id: string): Promise<{ ok: true; taskId: string; at: number } | { ok: false; error: string }> {
		// Resolve from disk when possible so an externally-deleted task can't
		// be resurrected from our (possibly not-yet-synced) memory.
		const freshResult = readTaskFreshChecked(this.scope, this.workspaceId, id);
		let task: ScheduledTask | undefined;
		if (freshResult.status === "found") task = freshResult.task;
		else if (freshResult.status === "unreadable") task = this.tasks.get(id);
		if (!task) return { ok: false, error: `Task not found: ${id}` };
		const unsupported = unsupportedSessionTargetReason(task);
		if (unsupported) return { ok: false, error: unsupported };
		// Use a fresh copy so sessionTarget / concurrencyPolicy /
		// timeoutMinutes patches take effect on this run.
		const fresh = { ...task, updatedAt: this.now() };
		const at = this.now();
		// Fire-and-forget — actual completion is signaled via events.
		void this.fireTask(fresh, at, /*manual*/ true);
		return { ok: true, taskId: id, at };
	}

	history(id: string, limit = 50): ScheduledTaskRun[] {
		return readRuns(this.scope, this.workspaceId, id, limit);
	}

	// --- internals ---

	private summarize(task: ScheduledTask, now: number): ScheduledTaskSummary {
		return {
			...task,
			// A capped-but-enabled task (e.g. maxRuns lowered below runCount via
			// update) never fires again — scheduleOne refuses it — so reporting
			// a nextRunAt would promise a run that can never happen.
			nextRunAt:
				task.enabled && !unsupportedSessionTargetReason(task) && !this.capReached(task)
					? nextRunAt(task, now)
					: null,
		};
	}

	private persist(): void {
		// Merge-preserve tasks written by other processes after our load (e.g.
		// the GUI creating a task for this workspace from a different sidecar):
		// unknown ids on disk survive our rewrite; tasks we know about always
		// win (our memory is authoritative, including deletions).
		// If the file exists but is unreadable (corrupt / transiently locked),
		// a blind write would destroy every task written by other processes.
		// Move the corrupt file aside (content preserved in a backup) and
		// repair from memory; if even the move fails (file locked), skip.
		let disk = readTasksChecked(this.scope, this.workspaceId);
		if (!disk.ok) {
			if (!recoverTasksFile(this.scope, this.workspaceId)) {
				console.warn(
					`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""}: tasks.json unreadable, skipping persist to avoid data loss`,
				);
				return;
			}
			disk = { ok: true, tasks: [] };
		}
		const merged: ScheduledTask[] = [];
		for (const t of disk.tasks) {
			if (!this.knownIds.has(t.id)) merged.push(t);
		}
		for (const t of this.tasks.values()) merged.push(t);
		writeTasks(this.scope, this.workspaceId, merged);
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
	}

	private scheduleAll(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		for (const t of this.tasks.values()) this.scheduleOne(t);
	}

	private catchUpMissedRuns(): void {
		const now = this.now();
		for (const task of this.tasks.values()) {
			const missedAt = this.lastMissedRunAt(task, now);
			if (missedAt === null) continue;
			const timer = setTimeout(() => {
				if (this.disposed) return;
				const current = this.tasks.get(task.id);
				if (!current?.enabled) return;
				void this.fireTask(current, missedAt, /*manual*/ false);
			}, 0);
			timer.unref?.();
		}
	}

	private lastMissedRunAt(task: ScheduledTask, now: number): number | null {
		if (!task.enabled || unsupportedSessionTargetReason(task)) return null;
		if (typeof task.lastRunAt !== "number") return null;

		let cursor = task.lastRunAt + 1;
		let missed: number | null = null;
		for (let i = 0; i < 5000; i++) {
			const next = nextRunAt(task, cursor);
			if (next === null || next >= now) break;
			missed = next;
			cursor = next + 1;
		}
		return missed;
	}

	private scheduleOne(task: ScheduledTask): void {
		// Idempotent (re)arm: ALWAYS drop any previously armed timer for this
		// task first. scheduleOne overwrites this.timers[task.id], so without
		// this the old handle leaks and keeps firing — e.g. a manual runNow
		// during a pending scheduled fire left BOTH timers alive and the task
		// dispatched twice (once with a stale snapshot).
		this.cancelTimer(task.id);
		if (!task.enabled || this.disposed || this.passive) return;
		if (this.capReached(task)) return;
		if (unsupportedSessionTargetReason(task)) return;
		const next = nextRunAt(task, this.now());
		if (next === null) return;
		const delay = Math.max(0, next - this.now());
		// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1ms,
		// which would fire a far-future task (monthly schedules, distant
		// startAt) immediately — and the post-run reschedule would loop the
		// same way. Chunk long waits: sleep MAX_TIMEOUT_MS, then recompute.
		const timer = delay > MAX_TIMEOUT_MS
			? setTimeout(() => {
					this.timers.delete(task.id);
					const current = this.tasks.get(task.id);
					if (current) this.scheduleOne(current);
				}, MAX_TIMEOUT_MS)
			: setTimeout(() => {
					this.timers.delete(task.id);
					void this.fireTask(task, next, /*manual*/ false);
				}, delay);
		// Don't keep the event loop alive solely for a scheduled fire.
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}
		this.timers.set(task.id, timer);
	}

	/**
	 * Run a task now (or at its scheduled fire time). The session-lock
	 * machinery guarantees that no two tasks run in the same target session
	 * concurrently, and the policy on the task decides what to do when
	 * the session is busy: skip / queue / preempt.
	 *
	 * Returns synchronously; the dispatch promise runs in the background
	 * and resolves when the agent turn completes (or errors / times out).
	 */
	private async fireTask(task: ScheduledTask, at: number, manual: boolean): Promise<void> {
		if (this.disposed) return;
		// Guard against early fires (timer overflow clamping, wall-clock jumps):
		// if the scheduled time is still in the future, put the task back on a
		// timer instead of running it ahead of schedule.
		if (!manual && at > this.now() + EARLY_FIRE_TOLERANCE_MS) {
			const current = this.tasks.get(task.id);
			if (current) this.scheduleOne(current);
			return;
		}
		// Re-read the task from disk right before firing. External edits
		// (another process pausing/deleting via tasks.json, _cron acting
		// cross-scope) must win over our stale in-memory copy — otherwise a
		// disabled task keeps firing until restart AND our persist() after the
		// run silently reverts the external change.
		const freshResult = readTaskFreshChecked(this.scope, this.workspaceId, task.id);
		let current: ScheduledTask;
		if (freshResult.status === "missing") {
			// Deleted externally — drop it from memory and stop rescheduling.
			this.cancelTimer(task.id);
			this.tasks.delete(task.id);
			return;
		}
		if (freshResult.status === "unreadable") {
			// Corrupt / transiently locked tasks.json: NOT a deletion. Degrade
			// to the in-memory copy so this fire still happens and the task is
			// not dropped (persist() also refuses to write while unreadable).
			const memory = this.tasks.get(task.id);
			if (!memory) return;
			current = memory;
		} else {
			current = freshResult.task;
		}
		if (!current.enabled && !manual) {
			// Paused externally — sync memory and skip this fire.
			this.cancelTimer(task.id);
			this.tasks.set(task.id, current);
			return;
		}
		this.tasks.set(task.id, current);
		if (unsupportedSessionTargetReason(current)) return;
		// maxRuns safety cap: refuse to fire once the cap is reached.
		if (!manual && this.capReached(current)) {
			this.disableForCap(current, at);
			return;
		}
		const sessionId = this.resolveTargetSessionId(current);
		const policy: ConcurrencyPolicy = current.concurrencyPolicy ?? "skip";

		const result = this.locks.acquire(current, sessionId, policy);
		if (result.kind === "skipped") {
			// The session is busy and the policy says drop this tick. Record it
			// and emit completion so the UI history reflects reality.
			const run: ScheduledTaskRun = {
				taskId: current.id,
				at,
				status: "skipped",
				reason: `session busy (held by ${result.holderTaskId})`,
			};
			appendRun(this.scope, this.workspaceId, run);
			this.tasks.set(current.id, {
				...current,
				lastRunAt: at,
				lastRunStatus: "skipped",
				updatedAt: this.now(),
				runCount: (current.runCount ?? 0) + 1,
			});
			this.persist();
			this.emit({ type: "task.completed", payload: run });
			// No nextRunAt change — a skipped tick is a no-op.
			return;
		}

		if (result.kind === "queued") {
			// The lock manager has enqueued us; it will call back via
			// lock.release() → runQueuedTask() once the holder finishes.
			return;
		}

		// result.kind === "acquired" — we hold the lock and get to dispatch.
		const lockedSessionId = result.lockedSessionId;
		this.emit({ type: "task.fired", payload: { taskId: current.id, at, sessionId: lockedSessionId } });
		this.running.add(current.id);
		try {
			const dispatchedTask = { ...current, updatedAt: this.now() };
			const dispatched = await this.runWhenRuntimeIdle(current.id, () => this.dispatcher.dispatch(dispatchedTask));
			let taskAfterDispatch = current;
			// Cache the session id the dispatcher used so subsequent
			// SessionTarget: current tasks can reuse it.
			if (dispatched.sessionId) {
				this.currentSessionId = dispatched.sessionId;
				const target = current.sessionTarget;
				if (target?.kind === "new") {
					// For SessionTarget: "new", migrate the lock from the
					// `pending:${taskId}` placeholder to the real session id the
					// dispatcher just reported.
					this.locks.reassign(lockedSessionId, dispatched.sessionId);
				} else if (
					target?.kind === "pinned" &&
					(!target.sessionId || target.sessionId !== dispatched.sessionId)
				) {
					// Two cases converge here:
					//  a) pinned with a sessionId that points to a closed
					//     historical session — the runtime continued it into a
					//     writable child before appending the prompt. Persist
					//     that resolved child so the task stays fixed instead
					//     of drifting through fresh children.
					//  b) pinned WITHOUT sessionId (cross-scope created: the
					//     writing sidecar couldn't backfill its own active
					//     session) — the dispatcher fell back to the active
					//     session. Pin it now so recurring fires target one
					//     conversation and the session task card anchors,
					//     instead of drifting to whatever is active each fire.
					this.locks.reassign(lockedSessionId, dispatched.sessionId);
					taskAfterDispatch = {
						...current,
						sessionTarget: { ...target, sessionId: dispatched.sessionId },
						updatedAt: this.now(),
					};
				}
			}

			const status: "ok" | "failed" = dispatched.error ? "failed" : "ok";
			const reason = dispatched.error;

			if (!this.recordedByTimeout.delete(current.id)) {
				const run: ScheduledTaskRun = {
					taskId: current.id,
					at,
					status,
					eventId: dispatched.eventId,
					sessionId: dispatched.sessionId,
					reason,
				};
				appendRun(this.scope, this.workspaceId, run);
				this.tasks.set(current.id, {
					...taskAfterDispatch,
					lastRunAt: at,
					lastRunStatus: status,
					lastRunEventId: dispatched.eventId,
					runCount: (current.runCount ?? 0) + 1,
					updatedAt: this.now(),
				});
				this.persist();
				this.emit({ type: "task.completed", payload: run });
			}

			const updated = this.tasks.get(current.id)!;
			if (updated.enabled && !this.disposed) {
				if (this.capReached(updated)) {
					// maxRuns reached after this run — auto-disable instead of
					// rescheduling, so runaway recurring tasks die on their own.
					this.disableForCap(updated, this.now());
				} else {
					const stillValid = !updated.schedule.endAt || updated.schedule.endAt > this.now();
					if (stillValid) this.scheduleOne(updated);
					else if (manual === false) {
						this.tasks.set(updated.id, { ...updated, enabled: false });
						this.persist();
					}
				}
			}
		} catch (e) {
			// Should not happen — dispatcher.dispatch itself is supposed to
			// catch and return { error }. This is belt-and-suspenders.
			const run: ScheduledTaskRun = {
				taskId: current.id,
				at,
				status: "failed",
				reason: e instanceof Error ? e.message : String(e),
			};
			appendRun(this.scope, this.workspaceId, run);
			this.tasks.set(current.id, {
				...current,
				lastRunAt: at,
				lastRunStatus: "failed",
				updatedAt: this.now(),
				runCount: (current.runCount ?? 0) + 1,
			});
			this.persist();
			this.emit({ type: "task.completed", payload: run });
		} finally {
			this.running.delete(current.id);
			this.recordedByTimeout.delete(current.id);
			// Release the lock. If something is queued, the manager will hand
			// the lock off and call back via onDispatchNext, which kicks off
			// the next fireTask in this same session.
			this.locks.release(current.id, (next) => {
				// Re-dispatch the queued task now. The lock manager has
				// already acquired the lock on its behalf.
				void this.fireTask(next, this.now(), /*manual*/ false);
			});
		}
	}

	/** True when the task has a maxRuns cap and has already hit it. */
	private capReached(task: ScheduledTask): boolean {
		return typeof task.maxRuns === "number" && task.maxRuns > 0 && (task.runCount ?? 0) >= task.maxRuns;
	}

	/** Disable a task that hit its maxRuns cap and record why. */
	private disableForCap(task: ScheduledTask, at: number): void {
		this.cancelTimer(task.id);
		this.tasks.set(task.id, { ...task, enabled: false, updatedAt: this.now() });
		this.persist();
		const run: ScheduledTaskRun = {
			taskId: task.id,
			at,
			status: "skipped",
			reason: `maxRuns cap reached (${task.runCount ?? 0}/${task.maxRuns}); task auto-disabled`,
		};
		appendRun(this.scope, this.workspaceId, run);
		this.emit({ type: "task.completed", payload: run });
	}

	private emit(event: { type: keyof SchedulerEngineEvents; payload: unknown }): void {
		this.listener?.(event);
		this.emitter.emit(event.type, ...(Array.isArray(event.payload) ? event.payload : [event.payload]));
	}

	private runWhenRuntimeIdle(
		taskId: string,
		dispatch: () => Promise<{ eventId?: string; sessionId?: string; error?: string }>,
	): Promise<{ eventId?: string; sessionId?: string; error?: string }> {
		const run = this.runtimeQueue.then(async () => {
			if (this.disposed || this.recordedByTimeout.has(taskId)) {
				return { error: "scheduler task cancelled before dispatch" };
			}
			return await dispatch();
		}, async () => {
			if (this.disposed || this.recordedByTimeout.has(taskId)) {
				return { error: "scheduler task cancelled before dispatch" };
			}
			return await dispatch();
		});
		this.runtimeQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Subscribe to engine events (returns an unsubscribe function). */
	subscribe(listener: SchedulerListener): () => void {
		const wrapped = (e: { type: keyof SchedulerEngineEvents; payload: unknown }) => listener(e);
		this.emitter.on("task.fired", wrapped as never);
		this.emitter.on("task.completed", wrapped as never);
		return () => {
			this.emitter.off("task.fired", wrapped as never);
			this.emitter.off("task.completed", wrapped as never);
		};
	}
}
