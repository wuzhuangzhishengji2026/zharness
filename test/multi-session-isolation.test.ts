import { describe, expect, it } from "vitest";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { SessionManager } from "../src/core/projection/session-manager.js";

/**
 * Prove that two conversations (v2 每会话一库) are isolated:
 *
 * 每个会话一个自包含事件库，isolation 不再靠 thread_id 标签过滤 —— A 的
 * buildContext 物理上不可能读到 B 的行。这里同时验证代理 store 的路由：
 * 追加永远落在"当前活跃会话"的库。
 */
describe("multi-conversation isolation (v2 per-session stores)", () => {
	function setup() {
		const files = new SessionFileStoreManager("ws_test", undefined, { storagePath: ":memory:" });
		const sessionManager = new SessionManager(files);
		const say = (text: string): void => {
			files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
		};
		return { files, sessionManager, say };
	}

	function texts(manager: SessionManager): string[] {
		return manager
			.getActiveSession()
			.buildContext()
			.messages.map((m) => ("content" in m ? String(m.content) : ""))
			.filter(Boolean);
	}

	it("conversation A never sees conversation B's events", () => {
		const { sessionManager, say } = setup();
		const a = sessionManager.getActiveSession().getDescriptor();
		say("question for A");

		const b = sessionManager.createSession("user_explicit", "B");
		say("question for B");

		sessionManager.jumpToSession(a.session_id);
		expect(texts(sessionManager)).toEqual(["question for A"]);
		sessionManager.jumpToSession(b.session_id);
		expect(texts(sessionManager)).toEqual(["question for B"]);
	});

	it("each session store has an independent event count", () => {
		const { files, sessionManager, say } = setup();
		const a = sessionManager.getActiveSession().getDescriptor();
		say("A1");
		say("A2");

		const b = sessionManager.createSession("user_explicit", "B");
		say("B1");

		// 每库多一条 SESSION_CREATED（显式新建发生命周期事件）。
		expect(sessionManager.getSessionProjection(a.session_id)!.getSessionEvents().length).toBe(3);
		expect(sessionManager.getSessionProjection(b.session_id)!.getSessionEvents().length).toBe(2);
		expect(files.active.size).toBe(2); // 代理路由到活跃库 B
	});
});
