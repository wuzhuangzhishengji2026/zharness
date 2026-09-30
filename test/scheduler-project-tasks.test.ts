/**
 * Regression tests for project (workspace-scope) scheduled tasks:
 *
 * 1. Tasks written to tasks.json by ANOTHER process (e.g. created from the
 *    main window for a project whose sidecar is already running) must be
 *    discovered by the running engine's tasks.json watcher and fired —
 *    previously they sat on disk forever ("task never executes in project").
 *
 * 2. Pinned tasks WITHOUT sessionId (cross-scope create couldn't backfill
 *    one) must still be scheduled — unsupportedSessionTargetReason used to
 *    silently drop them — and must pin to the session the dispatcher fell
 *    back to, so recurring fires target one conversation.
 *
 * 3. External deletes must propagate into a running engine (memory dropped),
 *    so the engine's next persist() doesn't resurrect the deleted task.
 *
 * 4. Cross-scope run-now requests (runRequestedAt marker written to
 *    tasks.json by a sidecar that doesn't serve the task's scope) are
 *    consumed by the owning engine — live via the watcher, or caught up at
 *    load() when the owner wasn't running when the request was written.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SchedulerEngine,
	readTasks,
	writeTasks,
	type Dispatcher,
	type ScheduledTask,
} from "../src/core/scheduler/index.js";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	const now = Date.now();
	return {
		id: "st_proj000000001",
		name: "project task",
		prompt: "hello",
		scope: "workspace",
		workspaceId: "ws-proj",
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

/** Poll `fn` until it returns truthy or `timeoutMs` elapses (real timers). */
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
	agentDir = mkdtempSync(join(tmpdir(), "zharness-scheduler-proj-"));
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

describe("scheduler: running engine discovers externally-written tasks", () => {
	it("fires a task written to tasks.json by another process", async () => {
		const dispatched: string[] = [];
		const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
			dispatched.push(task.id);
			return { sessionId: "sess_new" };
		};

		// The project sidecar is already running when the task is created.
		const engine = makeEngine("ws-proj", dispatchImpl);
		engine.load();
		expect(engine.list()).toHaveLength(0);

		// Another sidecar (serving a different scope) writes the task directly.
		const task = makeTask();
		writeTasks("workspace", "ws-proj", [task]);

		// Watcher (debounced) or the safety poll must adopt + fire it.
		await waitFor(() => dispatched.length > 0, 40_000);
		expect(dispatched).toContain(task.id);
		engine.dispose();
	});

	it("drops externally-deleted tasks so persist() cannot resurrect them", async () => {
		const dispatched: string[] = [];
		const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
			dispatched.push(task.id);
			return { sessionId: "sess_new" };
		};

		const engine = makeEngine("ws-proj2", dispatchImpl);
		engine.load();

		const created = engine.create({
			name: "kept",
			prompt: "kept",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "new", purpose: "test" },
		});
		expect(created.ok).toBe(true);

		const doomed = makeTask({ id: "st_proj000000002" });
		writeTasks("workspace", "ws-proj2", [...readTasks("workspace", "ws-proj2"), doomed]);
		await waitFor(() => engine.list().some((t) => t.id === doomed.id), 40_000);

		// External delete (mutateTaskAnyScope-style rewrite without the task).
		writeTasks(
			"workspace",
			"ws-proj2",
			readTasks("workspace", "ws-proj2").filter((t) => t.id !== doomed.id),
		);
		await waitFor(() => !engine.list().some((t) => t.id === doomed.id), 40_000);

		// A later persist (e.g. a run record) must not write the task back.
		const fired = await engine.runNow(created.ok ? created.task.id : "");
		expect(fired.ok).toBe(true);
		await waitFor(() => engine.list().some((t) => t.id === (created.ok ? created.task.id : "")), 5_000);
		const onDisk = readTasks("workspace", "ws-proj2");
		expect(onDisk.some((t) => t.id === doomed.id)).toBe(false);
		engine.dispose();
	});
});

describe("scheduler: pinned tasks without sessionId (cross-scope created)", () => {
	it("are scheduled and fire instead of being silently dropped", async () => {
		vi.useFakeTimers();
		try {
			const dispatched: string[] = [];
			const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
				dispatched.push(task.id);
				return { sessionId: "sess_active" };
			};

			const engine = makeEngine("ws-pin", dispatchImpl);
			engine.load();

			const created = engine.create({
				name: "pinned no id",
				prompt: "hello",
				schedule: { mode: "once" },
				sessionTarget: { kind: "pinned" },
			});
			expect(created.ok).toBe(true);
			// Previously nextRunAt was null (unsupported session target) and the
			// task never got a timer.
			expect(created.ok && created.task.nextRunAt).not.toBeNull();

			await vi.advanceTimersByTimeAsync(100);
			expect(dispatched).toContain(created.ok ? created.task.id : "");

			// The dispatcher fell back to the active session; the engine must
			// pin that session so recurring fires and the GUI task card anchor.
			const stored = readTasks("workspace", "ws-pin").find((t) => t.id === (created.ok ? created.task.id : ""));
			expect(stored?.sessionTarget).toEqual({ kind: "pinned", sessionId: "sess_active" });
			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("runNow works for pinned tasks without sessionId", async () => {
		const dispatched: string[] = [];
		const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
			dispatched.push(task.id);
			return { sessionId: "sess_active" };
		};

		const engine = makeEngine("ws-pin2", dispatchImpl);
		engine.load();

		const created = engine.create({
			name: "manual run",
			prompt: "hello",
			schedule: { mode: "once", startAt: Date.now() + 3_600_000 },
			sessionTarget: { kind: "pinned" },
		});
		expect(created.ok).toBe(true);

		// Previously this returned { ok: false } ("pinned session target is
		// missing sessionId") even though the dispatcher has an active-session
		// fallback.
		const r = await engine.runNow(created.ok ? created.task.id : "");
		expect(r.ok).toBe(true);
		await waitFor(() => dispatched.length > 0, 5_000);
		engine.dispose();
	});
});

describe("scheduler: cross-scope run-now requests (runRequestedAt marker)", () => {
	it("running engine consumes an externally-written marker and fires once", async () => {
		const dispatched: string[] = [];
		const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
			dispatched.push(task.id);
			return { sessionId: "sess_new" };
		};

		// Future one-shot: the schedule itself must not fire — only the
		// external run-now request may trigger a dispatch.
		const task = makeTask({
			id: "st_runnow0000001",
			schedule: { mode: "once", startAt: Date.now() + 3_600_000 },
		});
		writeTasks("workspace", "ws-runnow", [task]);
		const engine = makeEngine("ws-runnow", dispatchImpl);
		engine.load();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(dispatched).toHaveLength(0);

		// Another sidecar (serving a different scope) marks the task for
		// immediate run — exactly what the schedule_run_now RPC fallback does.
		writeTasks("workspace", "ws-runnow", [
			{ ...task, runRequestedAt: Date.now(), updatedAt: Date.now() },
		]);

		await waitFor(() => dispatched.length > 0, 40_000);
		// The marker must be cleared on disk and never fire twice.
		await new Promise((resolve) => setTimeout(resolve, 800));
		const onDisk = readTasks("workspace", "ws-runnow").find((t) => t.id === task.id);
		expect(onDisk?.runRequestedAt).toBeUndefined();
		expect(dispatched).toEqual([task.id]);
		engine.dispose();
	});

	it("catches up a pending marker on load (owner sidecar opens later)", async () => {
		const dispatched: string[] = [];
		const dispatchImpl: Dispatcher["dispatch"] = async (task) => {
			dispatched.push(task.id);
			return { sessionId: "sess_new" };
		};

		const task = makeTask({
			id: "st_runnow0000002",
			schedule: { mode: "once", startAt: Date.now() + 3_600_000 },
		});
		// Request persisted while NO engine was running for this scope.
		writeTasks("workspace", "ws-load", [
			{ ...task, runRequestedAt: Date.now(), updatedAt: Date.now() },
		]);

		const engine = makeEngine("ws-load", dispatchImpl);
		engine.load();

		await waitFor(() => dispatched.length > 0, 5_000);
		const onDisk = readTasks("workspace", "ws-load").find((t) => t.id === task.id);
		expect(onDisk?.runRequestedAt).toBeUndefined();
		engine.dispose();
	});
});
