/**
 * Headless tests for the session_split tool and event mapping.
 *
 * Verifies:
 * 1. mapTypedEventToModeEvents maps SESSION_BOUNDARY_INFERRED → session_split ModeEvent
 * 2. EventStoreExtensionSessionManager.splitSession（v2 每会话一库）：把尾部
 *    （含触发切分的用户消息）搬进新会话库、旧库截断，并落边界事件
 * 3. The session_split tool definition executes and returns success
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { SessionManager as ProjectionSessionManager } from "../src/core/projection/session-manager.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { createSessionSplitToolDefinition } from "../src/core/tools/session-split.js";
import { mapTypedEventToModeEvents } from "../src/modes/event-mapper.js";
import type { EventBase } from "../src/core/event-store/types.js";

let sequence = 0;

function mkEvent(type: string, payload: unknown): EventBase {
	sequence++;
	return {
		sequence,
		event_id: `evt-${sequence}`,
		workspace_id: "workspace",
		runtime_id: "runtime",
		actor_id: "runtime",
		timestamp: 1000 + sequence,
		type,
		payload,
	} as EventBase;
}

describe("session_split", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					/* best effort */
				}
			}
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `zharness-session-split-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeV2(cwd: string) {
		const files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:", cwd });
		const sessionManager = new ProjectionSessionManager(files);
		const projection = sessionManager.getActiveSession();
		const extSessionManager = new EventStoreExtensionSessionManager({
			store: files.active,
			projection,
			cwd,
			sessionManager,
		});
		const say = (text: string): void => {
			files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
		};
		return { files, sessionManager, extSessionManager, say };
	}

	// ── Event Mapper ────────────────────────────────────────────────────────

	describe("event-mapper", () => {
		it("maps SESSION_BOUNDARY_INFERRED to session_split ModeEvent", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_BOUNDARY_INFERRED", {
				reason: "intent_shift",
				new_session_id: "sess_new_123",
			}));

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({
				type: "session_split",
				eventId: expect.any(String),
				reason: "intent_shift",
				newSessionId: "sess_new_123",
			});
		});

		it("maps SESSION_BOUNDARY_INFERRED with different reason", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_BOUNDARY_INFERRED", {
				reason: "topic_change",
				new_session_id: "sess_abc",
			}));

			expect(events[0]).toMatchObject({
				type: "session_split",
				reason: "topic_change",
				newSessionId: "sess_abc",
			});
		});

		it("still ignores SESSION_CREATED (no mode event)", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_CREATED", {
				session_id: "sess_1",
				created_by: "user_explicit",
			}));
			expect(events).toEqual([]);
		});
	});

	// ── EventStoreExtensionSessionManager.splitSession ──────────────────────

	describe("EventStoreExtensionSessionManager.splitSession", () => {
		it("creates a new session and emits SESSION_BOUNDARY_INFERRED event", () => {
			const { files, sessionManager, extSessionManager, say } = makeV2(makeTempDir());
			say("hello world");

			const originalSessionId = extSessionManager.getSessionId();
			expect(extSessionManager.splitSession).toBeDefined();

			const result = extSessionManager.splitSession!("intent_shift", "New topic");
			expect(result).toBeDefined();
			expect(result!.session_id).not.toBe(originalSessionId);

			// 边界事件落在（已切换的）新会话库里。
			const events = files.active.query({ reverse: true });
			const boundaryEvent = events.find((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvent).toBeDefined();
			expect((boundaryEvent!.payload as any).reason).toBe("intent_shift");
			expect((boundaryEvent!.payload as any).new_session_id).toBe(result!.session_id);

			// The new session should be active
			expect(sessionManager.getActiveSessionId()).toBe(result!.session_id);

			sessionManager.dispose();
		});

		it("is a no-op when the active session has no new user message since the last split (loop guard)", () => {
			const { files, sessionManager, extSessionManager, say } = makeV2(makeTempDir());

			// First user message + first split -> creates a new session
			say("开新session做XXX");
			const first = extSessionManager.splitSession!("intent_shift");
			expect(first).toBeDefined();
			expect(first!.already_split).toBeUndefined();
			const firstSessionId = first!.session_id;

			// Second split within the same turn (no new user message) -> no-op。
			// 边界事件在触发消息之后 —— 新库里最近边界 > 最近用户消息。
			const second = extSessionManager.splitSession!("intent_shift");
			expect(second).toBeDefined();
			expect(second!.already_split).toBe(true);
			expect(second!.session_id).toBe(firstSessionId);

			// 新库里只有一个边界事件。
			const boundaryEvents = files.active.query({}).filter((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvents).toHaveLength(1);

			sessionManager.dispose();
		});

		it("allows a new split after a new user message arrives", () => {
			const { files, sessionManager, extSessionManager, say } = makeV2(makeTempDir());

			say("task A");
			const first = extSessionManager.splitSession!("intent_shift");
			expect(first!.already_split).toBeUndefined();

			// New user message in the new session, then split again -> allowed
			say("unrelated task B");
			const second = extSessionManager.splitSession!("topic_change");
			expect(second!.already_split).toBeUndefined();
			expect(second!.session_id).not.toBe(first!.session_id);

			// 当前（第三个）会话库里有它自己的边界事件，reason 正确。
			const boundaryEvents = files.active.query({}).filter((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvents).toHaveLength(1);
			expect((boundaryEvents[0]!.payload as any).reason).toBe("topic_change");

			sessionManager.dispose();
		});

		it("returns undefined when sessionManager is not provided", () => {
			const files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:" });
			const sessionManager = new ProjectionSessionManager(files);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store: files.active,
				projection,
				cwd: makeTempDir(),
				// sessionManager intentionally omitted
			});

			expect(extSessionManager.splitSession).toBeDefined();
			const result = extSessionManager.splitSession!("test");
			expect(result).toBeUndefined();

			sessionManager.dispose();
		});
	});

	// ── Tool Definition Execution ───────────────────────────────────────────

	describe("session_split tool", () => {
		it("executes successfully and returns session id", async () => {
			const { files, sessionManager, extSessionManager, say } = makeV2(makeTempDir());
			say("do a task");

			const toolDef = createSessionSplitToolDefinition();
			expect(toolDef.name).toBe("session_split");

			const ctx = { sessionManager: extSessionManager } as any;
			const result = await toolDef.execute(
				"test_call_id",
				{ reason: "topic_change", name: "Fix bugs" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as any).text).toContain("Session split successfully");
			expect((result.content[0] as any).text).toContain("New session:");

			sessionManager.dispose();
		});

		it("returns error message when splitSession is unavailable", async () => {
			const files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:" });
			const sessionManager = new ProjectionSessionManager(files);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store: files.active,
				projection,
				cwd: makeTempDir(),
				// sessionManager intentionally omitted
			});

			const toolDef = createSessionSplitToolDefinition();
			const ctx = { sessionManager: extSessionManager } as any;
			const result = await toolDef.execute("test_call_id", { reason: "test" }, undefined, undefined, ctx);

			expect(result.content).toHaveLength(1);
			expect((result.content[0] as any).text).toContain("not available");

			sessionManager.dispose();
		});

		it("uses default reason when none provided", async () => {
			const { files, sessionManager, extSessionManager, say } = makeV2(makeTempDir());
			say("do a task");

			const toolDef = createSessionSplitToolDefinition();
			const ctx = { sessionManager: extSessionManager } as any;
			const result = await toolDef.execute("test_call_id", {}, undefined, undefined, ctx);

			expect(result.content).toHaveLength(1);
			expect((result.content[0] as any).text).toContain("Session split successfully");

			// Verify default reason was used
			const events = files.active.query({ reverse: true });
			const boundaryEvent = events.find((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvent).toBeDefined();
			expect((boundaryEvent!.payload as any).reason).toBe("intent_shift");

			sessionManager.dispose();
		});
	});
});
