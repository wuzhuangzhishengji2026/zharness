/**
 * Headless tests for the history_tree tool, SessionManager (v2 per-session
 * stores), and the builtin command parsing.
 *
 * v2 模型：一个会话一个自包含事件库。jump = 切活跃指针继续追加原文件；
 * fork/rewind = 复制前缀进新库；没有封口/HEAD 哨兵/跨会话区间。
 */

import { describe, expect, it } from "vitest";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { SessionManager as ProjectionSessionManager } from "../src/core/projection/session-manager.js";
import { buildHistoryTreeNodes, renderHistoryTreeText, buildSessionBreadcrumb } from "../src/core/projection/history-tree.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { createHistoryTreeToolDefinition } from "../src/core/tools/history-tree.js";
import { parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

function makeV2(): {
	files: SessionFileStoreManager;
	sessionManager: ProjectionSessionManager;
	say: (text: string) => void;
} {
	const files = new SessionFileStoreManager("test-ws", undefined, { storagePath: ":memory:" });
	const sessionManager = new ProjectionSessionManager(files);
	const say = (text: string): void => {
		files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
	};
	return { files, sessionManager, say };
}

function makeExtManager(
	files: SessionFileStoreManager,
	sessionManager: ProjectionSessionManager,
): EventStoreExtensionSessionManager {
	return new EventStoreExtensionSessionManager({
		store: files.active,
		projection: sessionManager.getActiveSession(),
		cwd: "/tmp",
		sessionManager,
	});
}

describe("history_tree", () => {
	// ── 谱系树（manager 视角） ────────────────────────────────────────────────

	describe("buildLineageNodes", () => {
		it("organizes fork lineage into a depth-first tree with child counts", () => {
			const { sessionManager, say } = makeV2();
			const root = sessionManager.getActiveSession().getDescriptor();
			say("root task");

			const forked = sessionManager.forkFromSession(root.session_id);

			const nodes = sessionManager.files.buildLineageNodes();
			expect(nodes.length).toBe(2);
			const rootNode = nodes.find((n) => n.session_id === root.session_id)!;
			const forkNode = nodes.find((n) => n.session_id === forked.session_id)!;
			expect(rootNode.depth).toBe(0);
			expect(forkNode.depth).toBe(1);
			expect(forkNode.parent_session_id).toBe(root.session_id);
			expect(rootNode.child_count).toBe(1);
			expect(forkNode.is_active).toBe(true);
			expect(rootNode.snippet).toContain("root task");

			const text = renderHistoryTreeText(nodes);
			expect(text).toContain(root.session_id);
			expect(text).toContain("[active]");
		});

		it("scopes to the focus session's lineage", () => {
			const { sessionManager, say } = makeV2();
			const first = sessionManager.getActiveSession().getDescriptor();
			say("conversation one");
			const second = sessionManager.createSession("user_explicit", "conversation two");

			// 活跃在 second：默认树 = second 的谱系（无父 → 只有它自己）。
			expect(sessionManager.files.buildLineageNodes().map((n) => n.session_id)).toEqual([second.session_id]);
			// 显式 focus 到 first：看 first 的谱系。
			expect(sessionManager.files.buildLineageNodes(first.session_id).map((n) => n.session_id)).toEqual([
				first.session_id,
			]);
		});
	});

	// ── buildHistoryTreeNodes 纯函数（旧接口仍可用） ─────────────────────────

	describe("buildHistoryTreeNodes (pure)", () => {
		it("builds a tree from an explicit descriptor list", () => {
			const mk = (id: string, parent?: string): SessionDescriptor => ({
				session_id: id,
				thread_id: id,
				workspace_id: "ws",
				event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
				created_by: parent ? "fork" : "user_explicit",
				parent_session_id: parent,
				created_at: 1000,
			});
			const nodes = buildHistoryTreeNodes([mk("s1"), mk("s2", "s1"), mk("s3", "s1")], "s2");
			expect(nodes.map((n) => n.session_id)).toEqual(["s1", "s2", "s3"]);
			expect(nodes.find((n) => n.session_id === "s2")!.depth).toBe(1);

			const crumb = buildSessionBreadcrumb([mk("s1"), mk("s2", "s1")], "s2");
			expect(crumb).toContain("s1 → s2");
		});
	});

	// ── SessionManager.jumpToSession（v2：切指针） ───────────────────────────

	describe("SessionManager.jumpToSession", () => {
		it("is a no-op when jumping to the active session", () => {
			const { sessionManager } = makeV2();
			const active = sessionManager.getActiveSession().getDescriptor();
			const result = sessionManager.jumpToSession(active.session_id);
			expect(result.reopened).toBe(false);
			expect(result.descriptor.session_id).toBe(active.session_id);
		});

		it("switches to an old session and continues appending to ITS file", () => {
			const { sessionManager, say } = makeV2();
			const first = sessionManager.getActiveSession().getDescriptor();
			say("old work");
			sessionManager.createSession("user_explicit", "second");
			say("second work");

			const result = sessionManager.jumpToSession(first.session_id, "return to old work");
			expect(result.reopened).toBe(true);
			expect(sessionManager.getActiveSessionId()).toBe(result.descriptor.session_id);

			say("continued old work");
			const texts = sessionManager
				.getActiveSession()
				.buildContext()
				.messages.map((m) => ("content" in m ? String(m.content) : ""));
			// "second" 会话的内容不属于这段对话 —— 物理分账，天然隔离。
			expect(texts).toEqual(["old work", "continued old work"]);
		});

		it("leaves the previously active session's file untouched (no sealing)", () => {
			const { sessionManager, say } = makeV2();
			const first = sessionManager.getActiveSession().getDescriptor();
			say("first message");
			const second = sessionManager.createSession("user_explicit", "second");

			sessionManager.jumpToSession(first.session_id);
			say("more first messages");

			const secondContext = sessionManager.getSessionProjection(second.session_id)!.buildContext();
			expect(secondContext.messages).toHaveLength(0);
			expect(second.event_range.end_event_id).toBe("HEAD"); // 哨兵仅是兼容壳
		});

		it("throws for unknown session ids", () => {
			const { sessionManager } = makeV2();
			expect(() => sessionManager.jumpToSession("sess_missing")).toThrow("Session not found");
		});
	});

	// ── EventStoreExtensionSessionManager.historyTree ────────────────────────

	describe("EventStoreExtensionSessionManager.historyTree", () => {
		it("is undefined when sessionManager is not provided", () => {
			const { files, sessionManager } = makeV2();
			const extManager = new EventStoreExtensionSessionManager({
				store: files.active,
				projection: sessionManager.getActiveSession(),
				cwd: "/tmp",
			});
			expect(extManager.historyTree).toBeUndefined();
			sessionManager.dispose();
		});

		it("lists, views, jumps, and forks sessions", () => {
			const { sessionManager, say } = makeV2();
			const files = sessionManager.files;
			const extManager = makeExtManager(files, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			say("fix cli/args.ts parsing");

			sessionManager.createSession("user_explicit", "second topic");

			const historyTree = extManager.historyTree!;
			// 显式 focus 到 first 的谱系（"second topic" 无父，是另一棵树的根，
			// 不在 first 的谱系里）。
			const nodes = historyTree.list(first.session_id);
			expect(nodes.length).toBe(1);
			expect(nodes.find((n) => n.session_id === first.session_id)?.snippet).toContain("cli/args.ts");

			const view = historyTree.view(first.session_id);
			expect(view).toBeDefined();
			expect(view!.messages.some((line) => line.includes("cli/args.ts"))).toBe(true);

			const jump = historyTree.jump(first.session_id, "back to args work");
			expect(jump.reopened).toBe(true);
			expect(sessionManager.getActiveSessionId()).toBe(jump.session_id);

			const fork = historyTree.fork(first.session_id);
			expect(fork.session_id).not.toBe(first.session_id);
			expect(sessionManager.getSession(fork.session_id)?.parent_session_id).toBe(first.session_id);
			// fork 起空库（preserveHistory:false）：不含源历史。
			expect(sessionManager.getSessionProjection(fork.session_id)!.buildContext().messages).toHaveLength(0);
			// fork 之后 first 的谱系 = first + 新分支。
			expect(historyTree.list(first.session_id).length).toBe(2);

			sessionManager.dispose();
		});

		it("splitSession moves the tail (incl. the trigger message) into a new session file", () => {
			const { files, sessionManager, say } = makeV2();
			const first = sessionManager.getActiveSession().getDescriptor();
			say("earlier context");
			say("new topic please");
			const extManager = makeExtManager(files, sessionManager);

			const result = extManager.splitSession!("intent_shift");
			expect(result).toBeDefined();
			const newDesc = sessionManager.getSession(result!.session_id)!;
			expect(sessionManager.getActiveSessionId()).toBe(newDesc.session_id);

			// 新会话带着触发切分的用户消息继续。
			const newContext = sessionManager.getActiveSession().buildContext();
			expect(newContext.messages.some((m) => JSON.stringify(m).includes("new topic please"))).toBe(true);

			// 旧库被截断：触发消息不在旧会话的库里。
			sessionManager.jumpToSession(first.session_id);
			const oldContext = sessionManager.getActiveSession().buildContext();
			expect(oldContext.messages.some((m) => JSON.stringify(m).includes("new topic please"))).toBe(false);
			expect(oldContext.messages.some((m) => JSON.stringify(m).includes("earlier context"))).toBe(true);

			sessionManager.dispose();
		});
	});

	// ── Tool Definition Execution ────────────────────────────────────────────

	describe("history_tree tool", () => {
		it("lists the tree and filters by query", async () => {
			const { files, sessionManager, say } = makeV2();
			const extManager = makeExtManager(files, sessionManager);
			say("authentication bug hunt");
			sessionManager.createSession("user_explicit", "unrelated");
			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			// 默认活跃谱系 = "unrelated"（无父），只有 1 个节点。
			const listResult = await toolDef.execute("t1", { action: "list" }, undefined, undefined, ctx);
			expect((listResult.content[0] as any).text).toContain("Session history tree (1 node)");

			sessionManager.jumpToSession(
				sessionManager.listSessions().find((s) => s.name !== "unrelated")!.session_id,
			);
			const queryResult = await toolDef.execute(
				"t2",
				{ action: "list", query: "authentication" },
				undefined,
				undefined,
				ctx,
			);
			expect((queryResult.content[0] as any).text).toContain("authentication bug hunt");

			const noMatch = await toolDef.execute(
				"t3",
				{ action: "list", query: "nonexistent-topic" },
				undefined,
				undefined,
				ctx,
			);
			expect((noMatch.content[0] as any).text).toContain("No sessions match");

			sessionManager.dispose();
		});

		it("views, jumps, and forks via the tool", async () => {
			const { files, sessionManager, say } = makeV2();
			const extManager = makeExtManager(files, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			say("original topic");
			sessionManager.createSession("user_explicit", "second");

			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const viewResult = await toolDef.execute(
				"t1",
				{ action: "view", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((viewResult.content[0] as any).text).toContain(`Session ${first.session_id}`);
			expect((viewResult.content[0] as any).text).toContain("original topic");

			const jumpResult = await toolDef.execute(
				"t2",
				{ action: "jump", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((jumpResult.content[0] as any).text).toContain(`Jumped to session ${first.session_id}`);
			expect(sessionManager.getActiveSessionId()).toBe(first.session_id);

			const forkResult = await toolDef.execute(
				"t3",
				{ action: "fork", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((forkResult.content[0] as any).text).toContain("Forked session");
			expect(sessionManager.getActiveSessionId()).not.toBe(first.session_id);

			const missing = await toolDef.execute(
				"t4",
				{ action: "view", session_id: "sess_missing" },
				undefined,
				undefined,
				ctx,
			);
			expect((missing.content[0] as any).text).toContain("Session not found");

			sessionManager.dispose();
		});
	});

	// ── Builtin command parsing（不变） ──────────────────────────────────────

	describe("parseBuiltinToolInput", () => {
		it("parses history_tree commands", () => {
			const parsed = parseBuiltinToolInput("_history_tree", ["list"]);
			expect(parsed).toEqual({ command: "history_tree", input: { action: "list" } });
		});
	});
});
