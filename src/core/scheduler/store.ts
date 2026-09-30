/**
 * Scheduler storage.
 *
 * Two files per scope:
 *   - tasks.json   — single source of truth, atomic write (tmp + rename)
 *   - runs.jsonl   — append-only fire history
 *
 * Scopes (zharness data layout):
 *   - "main"      → ~/.zharness/main/scheduler/{tasks.json,runs.jsonl}
 *   - "workspace" → ~/.zharness/agent/workspaces/<workspaceId>/scheduler/{tasks.json,runs.jsonl}
 *
 * The store exposes a thin async API: `readTasks`, `writeTasks`, `appendRun`,
 * `readRuns`. Higher layers (engine.ts) wrap these with in-memory caches.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ScheduledTask, ScheduledTaskRun } from "@zharness/protocol";

import { getAgentDir, getMainDir } from "../../config.js";

const SCHEMA_VERSION = 1;

interface TasksFile {
	schemaVersion: number;
	tasks: ScheduledTask[];
}

export function getSchedulerDir(scope: "main" | "workspace", workspaceId?: string): string {
	if (scope === "main") {
		// Persistent main-agent data root: ~/.zharness/main (see config.getMainDir).
		return join(getMainDir(), "scheduler");
	}
	if (!workspaceId) throw new Error("workspaceId is required for workspace scope");
	// Sidecar workspace data root: ~/.zharness/agent/workspaces/<id> (see config.getAgentDir).
	return join(getAgentDir(), "workspaces", workspaceId, "scheduler");
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(path: string, data: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const json = JSON.stringify(data, null, 2);
	writeFileSync(tmp, json, "utf-8");
	// Best-effort cross-platform atomic replace: POSIX rename(2) replaces the
	// target atomically, but historical Node versions on Windows would throw
	// EEXIST when the target already exists. Unlink the stale target first
	// when we know it exists so the rename below is a true replace on every
	// supported platform. If the unlink fails we still attempt the rename so
	// we don't introduce new failure modes on POSIX.
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// Stale target may be locked or otherwise unremovable; renameSync
			// below will surface the real error if the rename cannot proceed.
		}
	}
	renameSync(tmp, path);
}

/** Read all tasks for the given scope. Returns [] on missing / corrupt file. */
export function readTasks(scope: "main" | "workspace", workspaceId?: string): ScheduledTask[] {
	const result = readTasksChecked(scope, workspaceId);
	return result.ok ? result.tasks : [];
}

export type ReadTasksResult = { ok: true; tasks: ScheduledTask[] } | { ok: false };

/**
 * Like readTasks, but distinguishes "no / empty file" (ok) from "file exists
 * but cannot be read or parsed" (not ok — e.g. a half-written file after a
 * crash, or a transiently locked file on Windows). Callers that would treat
 * [] as "everything was deleted externally" and then wipe state MUST use
 * this: a corrupt read is NOT an empty list.
 */
export function readTasksChecked(scope: "main" | "workspace", workspaceId?: string): ReadTasksResult {
	const dir = getSchedulerDir(scope, workspaceId);
	const file = join(dir, "tasks.json");
	if (!existsSync(file)) return { ok: true, tasks: [] };
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (e) {
		console.warn(`[scheduler] failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`);
		return { ok: false };
	}
	if (!raw.trim()) return { ok: true, tasks: [] };
	let parsed: TasksFile | ScheduledTask[];
	try {
		parsed = JSON.parse(raw) as TasksFile | ScheduledTask[];
	} catch (e) {
		console.warn(`[scheduler] failed to parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
		return { ok: false };
	}
	if (Array.isArray(parsed)) {
		// Legacy / foreign shape — wrap it.
		return { ok: true, tasks: parsed as ScheduledTask[] };
	}
	const ver = (parsed as TasksFile).schemaVersion;
	if (ver !== SCHEMA_VERSION) {
		console.warn(`[scheduler] unknown tasks.json schemaVersion=${ver}; returning empty list`);
		return { ok: true, tasks: [] };
	}
	return { ok: true, tasks: (parsed as TasksFile).tasks ?? [] };
}

/**
 * Atomically replace all tasks for the given scope.
 * Callers are expected to merge changes in memory first, then write back.
 */
export function writeTasks(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	tasks: ScheduledTask[],
): void {
	const dir = getSchedulerDir(scope, workspaceId);
	ensureDir(dir);
	atomicWriteJson(join(dir, "tasks.json"), { schemaVersion: SCHEMA_VERSION, tasks });
}

/** Append a run record to runs.jsonl. Best-effort — failures are logged, never thrown. */
export function appendRun(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	run: ScheduledTaskRun,
): void {
	const dir = getSchedulerDir(scope, workspaceId);
	try {
		ensureDir(dir);
		const file = join(dir, "runs.jsonl");
		writeFileSync(file, `${JSON.stringify(run)}\n`, { flag: "a", encoding: "utf-8" });
	} catch (e) {
		console.warn(
			`[scheduler] failed to append run for ${scope}:${run.taskId}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * Read recent runs for a specific task. Returns runs in reverse-chronological
 * order (newest first), capped at `limit`. Skips malformed lines.
 */
export function readRuns(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	taskId: string,
	limit = 50,
): ScheduledTaskRun[] {
	const dir = getSchedulerDir(scope, workspaceId);
	const file = join(dir, "runs.jsonl");
	if (!existsSync(file)) return [];
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (e) {
		console.warn(`[scheduler] failed to read runs.jsonl: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
	const out: ScheduledTaskRun[] = [];
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as ScheduledTaskRun;
			if (parsed.taskId === taskId) out.push(parsed);
			if (out.length >= limit) break;
		} catch {
			// Skip malformed lines.
		}
	}
	return out;
}

/** Test-only: get the directory path for a scope without creating it. */
export function getSchedulerDirForTest(scope: "main" | "workspace", workspaceId?: string): string {
	return getSchedulerDir(scope, workspaceId);
}

/** Read a workspace's cwd from its meta.json (for GUI project-name mapping). */
export function readWorkspaceCwd(workspaceId: string): string | undefined {
	const metaPath = join(getAgentDir(), "workspaces", workspaceId, "meta.json");
	if (!existsSync(metaPath)) return undefined;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { cwd?: string };
		return meta.cwd;
	} catch {
		return undefined;
	}
}

/**
 * Re-read one task straight from disk. Used by the engine right before a
 * fire so that external edits (another process pausing/deleting the task
 * by rewriting tasks.json) win over the stale in-memory copy.
 * Returns undefined when the task no longer exists on disk.
 */
export function readTaskFresh(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	taskId: string,
): ScheduledTask | undefined {
	return readTasks(scope, workspaceId).find((t) => t.id === taskId);
}

export type FreshTaskResult =
	| { status: "found"; task: ScheduledTask }
	| { status: "missing" }
	| { status: "unreadable" };

/**
 * Move an unreadable tasks.json aside (best effort) so it can be replaced.
 * The corrupt content is preserved in a `tasks.json.corrupt-<ts>-<pid>`
 * sibling — nothing is destroyed; it can be inspected or merged back by hand.
 * Returns true when the path is now free (or was already absent).
 */
export function recoverTasksFile(scope: "main" | "workspace", workspaceId?: string): boolean {
	const dir = getSchedulerDir(scope, workspaceId);
	const file = join(dir, "tasks.json");
	if (!existsSync(file)) return true;
	try {
		const backup = join(dir, `tasks.json.corrupt-${Date.now()}-${process.pid}`);
		renameSync(file, backup);
		console.warn(`[scheduler] corrupt tasks.json moved to ${backup}; repairing from memory`);
		return true;
	} catch (e) {
		console.warn(
			`[scheduler] failed to move corrupt tasks.json aside: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
}

/**
 * Like readTaskFresh, but tells "gone from disk" (missing) apart from
 * "disk unreadable right now" (unreadable — corrupt or locked file). A
 * missing task was deleted externally; an unreadable file must never be
 * mistaken for one — the engine keeps its in-memory copy in that case.
 */
export function readTaskFreshChecked(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	taskId: string,
): FreshTaskResult {
	const result = readTasksChecked(scope, workspaceId);
	if (!result.ok) return { status: "unreadable" };
	const task = result.tasks.find((t) => t.id === taskId);
	return task ? { status: "found", task } : { status: "missing" };
}

export interface ScopedTask {
	task: ScheduledTask;
	scope: "main" | "workspace";
	workspaceId?: string;
}

/**
 * Scan tasks across ALL scopes (main + every workspace dir). Read-only —
 * powers `_cron list --all` so tasks are never invisible just because they
 * belong to a different scope than the calling session.
 */
export function readTasksAllScopes(): ScopedTask[] {
	const out: ScopedTask[] = [];
	for (const task of readTasks("main")) {
		out.push({ task, scope: "main" });
	}
	const wsRoot = join(getAgentDir(), "workspaces");
	let entries: string[] = [];
	try {
		entries = existsSync(wsRoot) ? readdirSync(wsRoot) : [];
	} catch {
		return out;
	}
	for (const dir of entries) {
		if (!existsSync(join(wsRoot, dir, "scheduler", "tasks.json"))) continue;
		for (const task of readTasks("workspace", dir)) {
			out.push({ task, scope: "workspace", workspaceId: dir });
		}
	}
	return out;
}

/**
 * Locate a task by id in ANY scope and apply `mutate` to it, persisting the
 * result. `mutate` returning null means "delete the task". Enables cross-scope
 * pause/delete: the active engine in the owning process re-reads tasks.json
 * before each fire (see readTaskFresh), so the change takes effect at the
 * next tick without IPC.
 */
export function mutateTaskAnyScope(
	taskId: string,
	mutate: (task: ScheduledTask) => ScheduledTask | null,
): { found: false } | { found: true; scope: "main" | "workspace"; workspaceId?: string; deleted: boolean } {
	for (const entry of readTasksAllScopes()) {
		if (entry.task.id !== taskId) continue;
		const all = readTasks(entry.scope, entry.workspaceId);
		const idx = all.findIndex((t) => t.id === taskId);
		if (idx < 0) continue;
		const next = mutate(all[idx]!);
		if (next === null) {
			all.splice(idx, 1);
		} else {
			all[idx] = next;
		}
		writeTasks(entry.scope, entry.workspaceId, all);
		return { found: true, scope: entry.scope, workspaceId: entry.workspaceId, deleted: next === null };
	}
	return { found: false };
}