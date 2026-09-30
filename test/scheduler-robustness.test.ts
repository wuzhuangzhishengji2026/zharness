/**
 * Robustness tests for the scheduler — designed to surface remaining bugs:
 *
 * 1. A malformed cron expression (hand-edited tasks.json, or a task created
 *    through a path that skips validation) must not take down the whole
 *    scope: load() must not throw, list() must not throw, other tasks must
 *    keep firing.
 * 2. A corrupt / transiently unreadable tasks.json must NEVER be treated as
 *    "all tasks deleted": syncFromDisk keeps memory, fireTask keeps the
 *    in-memory copy, persist() must not wipe the file.
 * 3. runNow must not resurrect an externally-deleted task.
 * 4. A task whose maxRuns was lowered below runCount reports no nextRunAt.
 * 5. validateScheduleSpec rejects malformed cron / incomplete specs.
 * Plus behavior-pinning tests for concurrency policies, timeout flow, and
 * the early-manual-run + scheduled double fire of once tasks.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SchedulerEngine,
	readTasks,
	readRuns,
	validateScheduleSpec,
	writeTasks,
	type Dispatcher,
	type ScheduledTask,
} from "../src/core/scheduler/index.js";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	const now = Date.now();
	return {
		id: "st_robust00000001",
		name: "robust task",
		prompt: "hello",
		scope: "workspace",
		workspaceId: "ws-rob",
		schedule: { mode: "once" },
		enabled: true,
		createdAt: now - 60_000,
		updatedAt: now - 60_000,
		createdBy: "user",
		runCount: 0,
		sessionTarget: { kind: "new", purpose: "test" },
		concurrencyPolicy: "skip",
		...overrides,
	} as ScheduledTask;
}

function makeEngine(
	workspaceId: string,
	dispatch: Dispatcher["dispatch"],
): SchedulerEngine {
	return new SchedulerEngine({
		scope: "workspace",
		workspaceId,
		dispatcher: { dispatch },
	});
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "zharness-scheduler-rob-"));
	process.env.ZHARNESS_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.ZHARNESS_CODING_AGENT_DIR;
	try {
		rmSync(agentDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ── 1. Malformed cron must not kill the scope ───────────────────────────────

describe("scheduler: malformed cron expression is contained", () => {
	const BAD_CRON = "0 9 * *"; // 4 fields — parseCron throws

	it("load() does not throw and healthy tasks still get scheduled", () => {
		const engine = makeEngine("ws-cron", async () => ({ sessionId: "s" }));
		// One broken task + one healthy task on disk.
		writeTasks("workspace", "ws-cron", [
			makeTask({
				id: "st_robust0000000a",
				schedule: { mode: "cron", cron: { expression: BAD_CRON } },
			}),
			makeTask({ id: "st_robust0000000b" }),
		]);
		expect(() => engine.load()).not.toThrow();
		// The healthy task must still be schedulable.
		const healthy = engine.get("st_robust0000000b");
		expect(healthy?.nextRunAt).not.toBeNull();
		engine.dispose();
	});

	it("list()/get() do not throw; broken task reports nextRunAt=null", () => {
		const engine = makeEngine("ws-cron2", async () => ({ sessionId: "s" }));
		writeTasks("workspace", "ws-cron2", [
			makeTask({
				id: "st_robust0000000c",
				schedule: { mode: "cron", cron: { expression: "not a cron at all" } },
			}),
		]);
		engine.load();
		let list: ReturnType<SchedulerEngine["list"]> = [];
		expect(() => {
			list = engine.list();
		}).not.toThrow();
		expect(list[0]?.nextRunAt ?? null).toBeNull();
		engine.dispose();
	});
});

// ── 2. Corrupt tasks.json must never wipe tasks ─────────────────────────────

describe("scheduler: corrupt tasks.json is tolerated", () => {
	it("syncFromDisk keeps in-memory tasks when the file is corrupt", async () => {
		const engine = makeEngine("ws-corrupt", async () => ({ sessionId: "s" }));
		const created = engine.create({
			name: "survivor",
			prompt: "hello",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "new", purpose: "test" },
		});
		expect(created.ok).toBe(true);
		const createdId = created.ok ? created.task.id : "";

		// Corrupt the file on disk (half-written JSON — e.g. crash mid-write
		// or an antivirus holding the file). The watcher fires a sync.
		const tasksFile = join(agentDir, "workspaces", "ws-corrupt", "scheduler", "tasks.json");
		writeFileSync(tasksFile, '{"schemaVersion":1,"tasks":[{"id":"st_broken"', "utf-8");

		await waitFor(() => {
			try {
				// Wait until at least one sync ran after the corruption. We can't
				// observe the sync directly; poll the observable outcome instead.
				return false;
			} catch {
				return false;
			}
		}, 1500).catch(() => {});

		// The in-memory task must survive — a corrupt file is NOT "no tasks".
		expect(engine.list().some((t) => t.id === createdId)).toBe(true);

		// The next persist (triggered by a create) must repair the file from
		// memory: both tasks on disk, corrupt content moved to a backup.
		const second = engine.create({
			name: "second",
			prompt: "hello",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "new", purpose: "test" },
		});
		expect(second.ok).toBe(true);
		const onDisk = readTasks("workspace", "ws-corrupt");
		expect(onDisk.some((t) => t.id === createdId)).toBe(true);
		const backups = readdirSync(join(agentDir, "workspaces", "ws-corrupt", "scheduler")).filter((f) =>
			f.startsWith("tasks.json.corrupt-"),
		);
		expect(backups.length).toBeGreaterThanOrEqual(1);
		engine.dispose();
	});

	it("fireTask uses the in-memory copy when the disk read fails", async () => {
		const dispatched: string[] = [];
		const engine = makeEngine("ws-corrupt2", async (task) => {
			dispatched.push(task.id);
			return { sessionId: "s" };
		});
		// Once task, fireAt in the past → fires on load.
		const task = makeTask({ id: "st_robust0000000d" });
		writeTasks("workspace", "ws-corrupt2", [task]);
		engine.load();

		// Corrupt before the fire timer runs (next macrotask).
		const tasksFile = join(agentDir, "workspaces", "ws-corrupt2", "scheduler", "tasks.json");
		writeFileSync(tasksFile, "not json at all {{{", "utf-8");

		await waitFor(() => dispatched.length > 0, 10_000);
		expect(dispatched).toContain(task.id);
		// The task must NOT have been dropped as "externally deleted".
		expect(engine.list().some((t) => t.id === task.id)).toBe(true);
		engine.dispose();
	});
});

// ── 3. runNow must not resurrect an externally-deleted task ─────────────────

describe("scheduler: runNow respects external deletion", () => {
	it("refuses to run a task that no longer exists on disk", async () => {
		const dispatched: string[] = [];
		const engine = makeEngine("ws-runnow", async (task) => {
			dispatched.push(task.id);
			return { sessionId: "s" };
		});
		const created = engine.create({
			name: "doomed",
			prompt: "hello",
			schedule: { mode: "once", startAt: Date.now() + 3_600_000 },
			sessionTarget: { kind: "new", purpose: "test" },
		});
		expect(created.ok).toBe(true);
		const id = created.ok ? created.task.id : "";

		// External delete: rewrite the file without the task (memory still has
		// it — the watcher sync may not have run yet).
		writeTasks("workspace", "ws-runnow", []);
		engine.dispose();

		// A fresh engine that adopts the on-disk (empty) state, simulating the
		// owning sidecar: memory has nothing, so runNow must fail.
		const engine2 = makeEngine("ws-runnow", async (task) => {
			dispatched.push(task.id);
			return { sessionId: "s" };
		});
		engine2.load();
		const r = await engine2.runNow(id);
		expect(r.ok).toBe(false);
		expect(dispatched).toHaveLength(0);
		engine2.dispose();
	});
});

// ── 4. maxRuns cap and nextRunAt consistency ────────────────────────────────

describe("scheduler: maxRuns cap is reflected in nextRunAt", () => {
	it("a capped-but-enabled task reports nextRunAt=null", () => {
		const engine = makeEngine("ws-cap", async () => ({ sessionId: "s" }));
		const created = engine.create({
			name: "capped",
			prompt: "hello",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "new", purpose: "test" },
			maxRuns: 10,
		});
		expect(created.ok).toBe(true);
		const id = created.ok ? created.task.id : "";

		// Simulate runs already used, then lower the cap below runCount.
		engine.update(id, { maxRuns: 2 });
		// Bump runCount the way two recorded runs would (skip path counts too).
		const onDisk = readTasks("workspace", "ws-cap");
		const bumped = onDisk.map((t) => (t.id === id ? { ...t, runCount: 5 } : t));
		writeTasks("workspace", "ws-cap", bumped);
		engine.reload();

		const summary = engine.get(id);
		expect(summary?.enabled).toBe(true);
		expect(summary?.nextRunAt ?? null).toBeNull();
		engine.dispose();
	});
});

// ── 5. Validation surface ───────────────────────────────────────────────────

describe("validateScheduleSpec rejects malformed input", () => {
	it("rejects a cron expression that does not parse", () => {
		expect(validateScheduleSpec({ mode: "cron", cron: { expression: "0 9 * *" } })).not.toBeNull();
		expect(validateScheduleSpec({ mode: "cron", cron: { expression: "garbage" } })).not.toBeNull();
		expect(validateScheduleSpec({ mode: "cron", cron: { expression: "*/0 * * * *" } })).not.toBeNull();
	});

	it("accepts a valid cron expression", () => {
		expect(validateScheduleSpec({ mode: "cron", cron: { expression: "0 9 * * 1-5" } })).toBeNull();
	});

	it("rejects weekly without weekdays and monthly without days", () => {
		expect(validateScheduleSpec({ mode: "weekly", times: [{ hour: 9, minute: 0 }] })).not.toBeNull();
		expect(validateScheduleSpec({ mode: "monthly", times: [{ hour: 9, minute: 0 }] })).not.toBeNull();
	});
});

// ── 6. Behavior pinning: concurrency policies ───────────────────────────────

describe("scheduler: concurrency policies on a busy session", () => {
	function hangingDispatch() {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const dispatch: Dispatcher["dispatch"] = async (task) => {
			await gate;
			return { sessionId: "sess_shared" };
		};
		return { dispatch, release };
	}

	function recurringTask(id: string, policy: "skip" | "queue" | "preempt"): ScheduledTask {
		return makeTask({
			id,
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: policy,
		});
	}

	it("skip drops the second fire and records a skipped run", async () => {
		vi.useFakeTimers();
		try {
			const { dispatch, release } = hangingDispatch();
			const engine = makeEngine("ws-conc-skip", dispatch);
			engine.load();
			const a = engine.create({
				name: "A",
				prompt: "a",
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				sessionTarget: { kind: "pinned", sessionId: "sess_shared" },
				concurrencyPolicy: "skip",
			});
			const b = engine.create({
				name: "B",
				prompt: "b",
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				sessionTarget: { kind: "pinned", sessionId: "sess_shared" },
				concurrencyPolicy: "skip",
			});
			expect(a.ok && b.ok).toBe(true);

			const runA = await engine.runNow(a.ok ? a.task.id : "");
			expect(runA.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(10);
			const runB = await engine.runNow(b.ok ? b.task.id : "");
			expect(runB.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(10);

			// B was skipped (session busy) — recorded, not dispatched.
			const runsB = readRuns("workspace", "ws-conc-skip", b.ok ? b.task.id : "");
			expect(runsB[0]?.status).toBe("skipped");
			release();
			await vi.advanceTimersByTimeAsync(10);
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("queue runs the second task after the first completes", async () => {
		vi.useFakeTimers();
		try {
			const { dispatch, release } = hangingDispatch();
			const engine = makeEngine("ws-conc-q", dispatch);
			engine.load();
			const a = engine.create({
				name: "A",
				prompt: "a",
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				sessionTarget: { kind: "pinned", sessionId: "sess_shared_q" },
				concurrencyPolicy: "queue",
			});
			const b = engine.create({
				name: "B",
				prompt: "b",
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				sessionTarget: { kind: "pinned", sessionId: "sess_shared_q" },
				concurrencyPolicy: "queue",
			});
			expect(a.ok && b.ok).toBe(true);

			await engine.runNow(a.ok ? a.task.id : "");
			await vi.advanceTimersByTimeAsync(10);
			await engine.runNow(b.ok ? b.task.id : "");
			await vi.advanceTimersByTimeAsync(10);

			// B is queued, not yet dispatched.
			expect(readRuns("workspace", "ws-conc-q", b.ok ? b.task.id : "")[0]?.status).toBeUndefined();

			release();
			await vi.advanceTimersByTimeAsync(50);

			const runsB = readRuns("workspace", "ws-conc-q", b.ok ? b.task.id : "");
			expect(runsB[0]?.status).toBe("ok");
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── 7. Behavior pinning: timeout flow ───────────────────────────────────────

describe("scheduler: timeout flow", () => {
	it("aborts the dispatch, records exactly one failed run, releases the lock", async () => {
		vi.useFakeTimers();
		try {
			let aborted = 0;
			let releaseDispatch: (() => void) | undefined;
			const engine = new SchedulerEngine({
				scope: "workspace",
				workspaceId: "ws-timeout",
				dispatcher: {
					dispatch: async () => {
						// Never resolves on its own; abort releases the gate.
						await new Promise<void>((resolve) => {
							releaseDispatch = resolve;
						});
						return { sessionId: "sess_t" };
					},
					abort: () => {
						aborted += 1;
						releaseDispatch?.();
					},
				},
			});

			engine.load();
			const created = engine.create({
				name: "slow",
				prompt: "hello",
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				sessionTarget: { kind: "pinned", sessionId: "sess_t" },
				timeoutMinutes: 1,
			});
			expect(created.ok).toBe(true);
			const id = created.ok ? created.task.id : "";

			await engine.runNow(id);
			await vi.advanceTimersByTimeAsync(10);
			expect(aborted).toBe(0);

			// 1 minute later the lock times out → abort + record.
			await vi.advanceTimersByTimeAsync(60_000 + 1000);
			expect(aborted).toBe(1);
			await vi.advanceTimersByTimeAsync(50);

			const runs = readRuns("workspace", "ws-timeout", id);
			expect(runs).toHaveLength(1);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.reason).toContain("timeout");
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── 8. Behavior pinning: once task double fire after early manual run ───────

describe("scheduler: once task fired early still fires at its scheduled time", () => {
	it("manual run does not cancel the future scheduled fire", async () => {
		vi.useFakeTimers();
		try {
			const dispatched: string[] = [];
			const engine = makeEngine("ws-once2", async (task) => {
				dispatched.push(task.id);
				return { sessionId: "s" };
			});
			engine.load();
			const fireAt = Date.now() + 60_000;
			const created = engine.create({
				name: "once",
				prompt: "hello",
				schedule: { mode: "once", startAt: fireAt },
				sessionTarget: { kind: "new", purpose: "test" },
			});
			expect(created.ok).toBe(true);
			const id = created.ok ? created.task.id : "";

			// Manual run 30s before the scheduled time.
			await vi.advanceTimersByTimeAsync(30_000);
			await engine.runNow(id);
			await vi.advanceTimersByTimeAsync(10);
			expect(dispatched).toHaveLength(1);

			// At the scheduled time it fires again.
			await vi.advanceTimersByTimeAsync(31_000);
			expect(dispatched).toHaveLength(2);
			expect(dispatched[1]).toBe(id);
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── 9. Behavior pinning: external pause is adopted live ─────────────────────

describe("scheduler: external pause is adopted by the running engine", () => {
	it("stops the future fire after an external disable", async () => {
		const dispatched: string[] = [];
		const engine = makeEngine("ws-pause", async (task) => {
			dispatched.push(task.id);
			return { sessionId: "s" };
		});
		const fireAt = Date.now() + 5_000;
		const task = makeTask({
			id: "st_robust0000000e",
			schedule: { mode: "once", startAt: fireAt },
		});
		writeTasks("workspace", "ws-pause", [task]);
		engine.load();

		// External pause before the fire time.
		writeTasks("workspace", "ws-pause", [{ ...task, enabled: false, updatedAt: Date.now() }]);
		await waitFor(() => engine.list().every((t) => t.id !== task.id || !t.enabled), 40_000);

		// Wait past the original fire time — nothing must dispatch.
		await new Promise((r) => setTimeout(r, 6_000));
		expect(dispatched).toHaveLength(0);
		engine.dispose();
	});
});
