/**
 * Session Projection tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

describe("SessionProjection", () => {
	const testDir = join(tmpdir(), ".test-zharness-projection", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "projection-events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function createDescriptor(overrides?: Partial<SessionDescriptor>): SessionDescriptor {
		return {
			session_id: "sess_test",
			thread_id: "thread_test",
			workspace_id: "test-ws",
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
			...overrides,
		};
	}

	it("should build empty context from empty store", () => {
		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(0);
		expect(context.events).toHaveLength(0);
		expect(context.descriptor.session_id).toBe("sess_test");
	});

	it("should build context with user and agent messages", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Hello agent" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hello user" }],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, total: 30, cost: 0.001 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should build context with tool results", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Read file.ts" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "file.ts" } }],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15, cost: 0.001 },
				stop_reason: "tool_use",
			},
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call_1",
				tool_name: "read",
				result: [{ type: "text", text: "file contents here" }],
				is_error: false,
				duration_ms: 50,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(3);
		expect(context.messages[2].role).toBe("toolResult");
	});

	it("drops orphan toolResult messages whose toolCall is outside the range", () => {
		// 回合中发生会话跳转(jump/fork)后,新会话区间可能只含工具结果,
		// 发出 toolCall 的 assistant 消息留在旧会话区间 —— 服务商对没有
		// 匹配 tool_call 的 tool 消息直接 400。buildContext 必须丢弃它们。
		const jumpResult = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call_orphan",
				tool_name: "cli",
				result: [{ type: "text", text: "Jumped to session X" }],
				is_error: false,
				duration_ms: 10,
			},
		});
		store.append({
			actor_id: "user",
			type: "BRANCH_SUMMARY",
			payload: { summary: "用户: 你好\n助手: 你好！", from_branch: "sess_old" },
		});

		const projection = new SessionProjection(
			store,
			createDescriptor({ event_range: { start_event_id: jumpResult.event_id, end_event_id: "HEAD" } }),
		);
		const context = projection.buildContext();

		expect(context.messages.some((m) => m.role === "toolResult")).toBe(false);
	});

	it("should include compaction events once when building context", () => {
		const summary = store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Compacted context",
				first_kept_event_id: "evt-keep",
				tokens_before: 12000,
				tokens_after: 900,
			},
		});

		const projection = new SessionProjection(
			store,
			createDescriptor({ summary_event_id: summary.event_id }),
		);
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[0] as any).summary).toBe("Compacted context");
	});

	it("should treat COMPACTION_END first_kept_event_id as a context boundary", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old request" } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "old response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Old request and response were summarized",
				first_kept_event_id: kept.event_id,
				tokens_before: 9000,
				tokens_after: 1000,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[1] as any).content).toBe("kept request");
		expect(context.messages.some((message) => JSON.stringify(message).includes("old request"))).toBe(false);
	});

	it("should skip non-context events like AGENT_THINKING_START", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hi" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_START", payload: { message_count: 1 } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_END", payload: { tool_calls_count: 0 } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_END", payload: {} });

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		// Only USER_MESSAGE and AGENT_MESSAGE_END should produce messages
		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should apply token budget truncation", () => {
		// Add many messages
		for (let i = 0; i < 100; i++) {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: `Message ${i}` } });
		}

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext({ max_tokens: 500 }); // 500 / 100 = 5 messages max

		expect(context.messages.length).toBeLessThan(100);
	});

	it("should return timeline entries", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hello" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hi" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const timeline = projection.getTimeline();

		expect(timeline).toHaveLength(3);
		expect(timeline[0].kind).toBe("user_message");
		expect(timeline[0].summary).toContain("User:");
		expect(timeline[2].kind).toBe("agent_message");
		expect(timeline[2].summary).toContain("Agent");
	});

	it("projects inherited segments ∪ main segment for rewind branches", () => {
		const e1 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "A" } });
		const e2 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "C" } });
		const marker = store.append({ actor_id: "runtime", type: "SESSION_FORKED", payload: {} });
		const e4 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "D" } });

		// rewind(B):继承段 (ORIGIN, B] 含端点 B,主段 (SESSION_FORKED, HEAD]。
		const projection = new SessionProjection(
			store,
			createDescriptor({
				event_range: { start_event_id: marker.event_id, end_event_id: "HEAD" },
				inherited_ranges: [{ start_event_id: "ORIGIN", end_event_id: e2.event_id }],
			}),
		);
		const texts = projection
			.getSessionEvents(["USER_MESSAGE"])
			.map((e) => (e.payload as { content: string }).content);
		expect(texts).toEqual(["A", "B", "D"]);

		// 全量视面(timeline 用)同样按段拼接、按日志序排序。
		expect(projection.getTimeline().map((t) => t.event_id)).toEqual([
			e1.event_id,
			e2.event_id,
			e4.event_id,
		]);
	});
});

describe("SessionManager (v2: per-session stores)", () => {
	let files: SessionFileStoreManager;
	let manager: SessionManager;

	beforeEach(() => {
		files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:" });
		manager = new SessionManager(files);
		// 惰性建会话：真实流程里 facade 工厂先调 getActiveSession()，这里同序。
		manager.getActiveSession();
	});

	afterEach(() => {
		manager.dispose();
	});

	const userTexts = (mgr: SessionManager): string[] =>
		mgr
			.getActiveSession()
			.buildContext()
			.messages.map((m) => ("content" in m ? String(m.content) : ""))
			.filter(Boolean);

	const say = (text: string): void => {
		files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
	};

	it("creates a session on first access", () => {
		const session = manager.getActiveSession();
		expect(session).toBeDefined();
		expect(manager.getActiveSessionId()).toBeDefined();
	});

	it("creates named sessions", () => {
		const desc = manager.createSession("user_explicit", "My Session");
		expect(desc.name).toBe("My Session");
		expect(manager.getActiveSessionId()).toBe(desc.session_id);
	});

	it("lists sessions", () => {
		manager.createSession("user_explicit", "Session A");
		manager.createSession("user_explicit", "Session B");
		expect(manager.listSessions()).toHaveLength(3); // 惰性首会话 + 两个
	});

	it("switches sessions (jump = 切指针，不复制)", () => {
		const s1 = manager.createSession("user_explicit", "Session 1");
		const s2 = manager.createSession("user_explicit", "Session 2");
		expect(manager.getActiveSessionId()).toBe(s2.session_id);

		const result = manager.jumpToSession(s1.session_id);
		expect(result.reopened).toBe(true);
		expect(manager.getActiveSessionId()).toBe(s1.session_id);

		// 继续追加落回被切换的会话自己的库。
		say("continued in s1");
		expect(userTexts(manager)).toEqual(["continued in s1"]);
	});

	it("throws when switching to non-existent session", () => {
		expect(() => manager.switchTo("sess_missing")).toThrow("Session not found");
	});

	it("renames sessions", () => {
		const desc = manager.createSession("user_explicit", "Old Name");
		manager.renameSession(desc.session_id, "New Name");
		expect(manager.getSession(desc.session_id)?.name).toBe("New Name");
	});

	it("rewind (forkAt) copies the ≤event prefix into a new session; old file keeps the tail", () => {
		const first = manager.getActiveSession().getDescriptor();
		say("A");
		const b = files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		say("C");

		const forked = manager.forkAt(b.event_id);
		expect(manager.getActiveSessionId()).toBe(forked.session_id);
		// 新会话 = [A, B]（含 B）；D 接在其后。
		say("D");
		expect(userTexts(manager)).toEqual(["A", "B", "D"]);

		// 旧会话文件原样保留 [A, B, C]。
		const old = manager.getSessionProjection(first.session_id)!;
		expect(
			old
				.buildContext()
				.messages.map((m) => ("content" in m ? String(m.content) : ""))
				.filter(Boolean),
		).toEqual(["A", "B", "C"]);

		// 谱系指针。
		expect(forked.parent_session_id).toBe(first.session_id);
	});

	it("forkFromSession preserves history by full copy; source untouched", () => {
		const source = manager.getActiveSession().getDescriptor();
		say("source message");

		const forked = manager.forkFromSession(source.session_id);
		expect(forked.parent_session_id).toBe(source.session_id);
		expect(
			manager
				.getSessionProjection(forked.session_id)!
				.buildContext()
				.messages.map((m) => ("content" in m ? String(m.content) : "")),
		).toEqual(["source message"]);
		// 源未被"封口"（概念已删）：继续活跃位的切换由调用方显式进行。
		expect(manager.getSessionProjection(source.session_id)!.buildContext().messages).toHaveLength(1);

		say("fork message");
		expect(
			manager
				.getSessionProjection(forked.session_id)!
				.buildContext()
				.messages.map((m) => ("content" in m ? String(m.content) : "")),
		).toEqual(["source message", "fork message"]);
	});

	it("forkFromSession without history starts an empty store carrying the summary ref", () => {
		const source = manager.getActiveSession().getDescriptor();
		say("source message");
		const forked = manager.forkFromSession(source.session_id, { preserveHistory: false });
		expect(
			manager
				.getSessionProjection(forked.session_id)!
				.buildContext()
				.messages.map((m) => ("content" in m ? String(m.content) : "")),
		).toEqual([]);
	});

	it("persists sessions across manager restarts (real dirs)", () => {
		const dir = join(tmpdir(), ".test-zharness-v2-persist", String(Date.now()));
		mkdirSync(dir, { recursive: true });
		try {
			const files1 = new SessionFileStoreManager("test-ws", dir);
			const manager1 = new SessionManager(files1);
			const s1 = manager1.createSession("user_explicit", "Persisted");
			manager1.dispose();

			const manager2 = new SessionManager(new SessionFileStoreManager("test-ws", dir));
			const list = manager2.listSessions();
			expect(list.map((s) => s.session_id)).toContain(s1.session_id);
			expect(manager2.getActiveSessionId()).toBe(s1.session_id); // 活跃指针持久化
			manager2.dispose();
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* Windows 句柄释放滞后，清理尽力而为 */
			}
		}
	});
});

describe("rewind semantics (v2: 每会话一库)", () => {
	let files: SessionFileStoreManager;
	let manager: SessionManager;

	beforeEach(() => {
		files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:" });
		manager = new SessionManager(files);
		// 惰性建会话：真实流程里 facade 工厂先调 getActiveSession()，这里同序。
		manager.getActiveSession();
	});

	afterEach(() => {
		manager.dispose();
	});

	const userTexts = (): string[] =>
		manager
			.getActiveSession()
			.buildContext()
			.messages.map((m) => ("content" in m ? String(m.content) : ""))
			.filter(Boolean);

	const say = (text: string): void => {
		files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
	};

	it("rewinding keeps history up to the event and drops the tail", () => {
		say("A");
		const b = files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		say("C");

		manager.forkAt(b.event_id);
		expect(userTexts()).toEqual(["A", "B"]);
		say("D");
		expect(userTexts()).toEqual(["A", "B", "D"]);
	});

	it("chained rewinds keep cutting from the current file", () => {
		say("A");
		const b = files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		say("C");

		manager.forkAt(b.event_id); // [A, B]
		const a2 = files.active.append; // noop reference guard
		void a2;
		// 当前文件此刻是 [A, B]（复制品）；再回到 A 所在位置需要 A 的新 id ——
		// 复制保 id，A 的事件 id 不变。
		const aId = manager
			.getActiveSession()
			.buildContext()
			.sourceEventIds?.[0];
		expect(aId).toBeDefined();
		manager.forkAt(aId!);
		expect(userTexts()).toEqual(["A"]);
	});
});
