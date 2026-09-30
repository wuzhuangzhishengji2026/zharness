/**
 * Regression tests for the "scheduled tasks never fire" fixes:
 *
 * 1. `once` tasks without startAt (fireAt = createdAt) used to return null
 *    from nextRunAt because the strict `fireAt < from` check saw the 1ms
 *    gap between create() and scheduleOne() — the task never got a timer.
 *    Now a never-run once task fires even when slightly overdue.
 *
 * 2. A passive engine (lost the cross-process scope lock) used to stay
 *    passive forever after the lock holder died, silently stopping all
 *    dispatch in the scope. It now retries the lock every STALE_MS and
 *    promotes itself to active once the lock is free/stale.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SchedulerEngine,
	STALE_MS,
	type Dispatcher,
	nextRunAt,
} from "../src/core/scheduler/index.js";
import type { ScheduledTask } from "../src/core/scheduler/index.js";

function makeOnceTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	const now = Date.now();
	return {
		id: "st_test0000000001",
		name: "test once",
		prompt: "hello",
		scope: "workspace",
		workspaceId: "ws-test",
		schedule: { mode: "once" },
		enabled: true,
		createdAt: now - 1000,
		updatedAt: now - 1000,
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

describe("scheduler: once tasks that never fired (regression)", () => {
	it("nextRunAt returns the overdue fireAt for a never-run once task", () => {
		const task = makeOnceTask();
		expect(nextRunAt(task, Date.now())).not.toBeNull();
	});

	it("nextRunAt returns null once the once task has already run", () => {
		const task = makeOnceTask({ runCount: 1 });
		expect(nextRunAt(task, Date.now())).toBeNull();
	});

	it("nextRunAt still honors a future startAt", () => {
		const future = Date.now() + 60_000;
		const task = makeOnceTask({ schedule: { mode: "once", startAt: future } });
		expect(nextRunAt(task, Date.now())).toBe(future);
	});
});

describe("scheduler: create() preserves the dialog's schedule.startAt", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "zharness-scheduler-test-"));
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

	it("does not wipe schedule.startAt when the top-level startAt is unset", async () => {
		vi.useFakeTimers();
		try {
			const engine = makeEngine("ws-once", async () => ({ sessionId: "sess_test" }));
			engine.load();
			const future = Date.now() + 3600_000;
			const created = engine.create({
				name: "test4",
				prompt: "hello",
				// The GUI dialog sends the once fire time embedded in schedule
				// and leaves the top-level startAt unset.
				schedule: { mode: "once", startAt: future },
				sessionTarget: { kind: "new", purpose: "test" },
			});
			expect(created.ok).toBe(true);
			// The chosen time must survive creation (previously it was wiped by
			// `startAt: input.startAt` assigning undefined) so the task fires at
			// the user's time, not immediately at createdAt.
			expect(created.ok && created.task.schedule.startAt).toBe(future);
			// And no immediate dispatch happened for the future task.
			expect(created.ok && created.task.nextRunAt).toBe(future);
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("scheduler: passive engine re-acquires a dead holder's scope lock", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "zharness-scheduler-test-"));
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

	it("promotes from passive to active and dispatches once the holder dies", async () => {
		vi.useFakeTimers();
		try {
			const dispatched: string[] = [];
			const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
				dispatched.push(task.id);
				return { sessionId: "sess_test" };
			};

			// Engine A owns the scope lock and is active.
			const engineA = makeEngine("ws-test", dispatchImpl);
			engineA.load();

			// Engine B starts while A holds the lock → passive.
			const engineB = makeEngine("ws-test", dispatchImpl);
			engineB.load();

			// A task created (via the store) for the scope; B has it in memory
			// but must not dispatch while passive.
			const engineC = makeEngine("ws-test", dispatchImpl);
			const task = makeOnceTask({ id: "st_test0000000002" });
			const created = engineC.create({
				name: task.name,
				prompt: task.prompt,
				schedule: task.schedule,
				sessionTarget: task.sessionTarget,
				createdBy: "user",
			});
			expect(created.ok).toBe(true);
			const createdId = created.ok ? created.task.id : "";
			engineC.dispose();

			expect(dispatched).toHaveLength(0);

			// A dies without the engine-level cleanup → dispose releases the
			// lock file, simulating the holder going away.
			engineA.dispose();

			// Before STALE_MS elapses, B must still be passive.
			await vi.advanceTimersByTimeAsync(STALE_MS - 1000);
			expect(dispatched).toHaveLength(0);

			// After the retry interval, B takes over and fires the overdue task.
			await vi.advanceTimersByTimeAsync(STALE_MS);
			expect(dispatched).toContain(createdId);

			engineB.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("never steals the lock while the holder is alive", async () => {
		vi.useFakeTimers();
		try {
			const dispatched: string[] = [];
			const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
				dispatched.push(task.id);
				return { sessionId: "sess_test" };
			};

			const engineA = makeEngine("ws-test2", dispatchImpl);
			engineA.load();
			const engineB = makeEngine("ws-test2", dispatchImpl);
			engineB.load();

			// Well past several retry intervals with A alive and heartbeating:
			// B must remain passive and never dispatch.
			await vi.advanceTimersByTimeAsync(STALE_MS * 3);
			expect(dispatched).toHaveLength(0);

			engineA.dispose();
			engineB.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
