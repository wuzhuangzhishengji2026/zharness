import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { SessionManager } from "../src/core/projection/session-manager.js";

/**
 * 会话生命周期事件（v2 每会话一库）。
 *
 * v1 共享日志上，createSession/fork/jump 会向日志追加 SESSION_CREATED /
 * SESSION_FORKED / SESSION_JUMPED。v2 分账后这些操作只切活跃指针 —— 若
 * 不补发事件，两个消费方就瞎了：
 *   1. 前端 ChatView 靠这三种事件触发时间线重载（新建会话/回放/跳转后
 *      界面不刷新，看起来像「点了没反应」）；
 *   2. reactor 靠 SESSION_FORKED/JUMPED 在回合中重指向活跃会话投影。
 *
 * 不变量：
 *   - 事件发在「切完活跃指针之后」，经活跃代理 append —— 既落在新库尾部，
 *     又扇出给代理订阅者（facade → rpc → 前端）；
 *   - fork 路径复制源事件（保留原 sequence）之后才发 SESSION_FORKED，
 *     且 fork/split 的新库不发 SESSION_CREATED（v1 语义）；
 *   - 构造/迁移/恢复活跃指针不产生任何生命周期事件（启动不污染历史库）。
 */

function setup() {
	const files = new SessionFileStoreManager("ws_lifecycle", undefined, { storagePath: ":memory:" });
	const sessionManager = new SessionManager(files);
	const say = (text: string): void => {
		files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
	};
	const seen: string[] = [];
	files.active.subscribe((event) => seen.push(event.type));
	return { files, sessionManager, say, seen };
}

describe("session lifecycle events (v2 per-session stores)", () => {
	it("createSession appends SESSION_CREATED to the new store and fans it out", () => {
		const { files, seen } = setup();

		const header = files.createSession({ created_by: "user_explicit", name: "hello" });

		const store = files.openStore(header.session_id);
		const created = store.query({ types: ["SESSION_CREATED"] });
		expect(created).toHaveLength(1);
		expect(created[0]!.payload).toMatchObject({
			session_id: header.session_id,
			name: "hello",
			created_by: "user_explicit",
		});
		// 新库的第一条事件就是创建事件（发在切指针后、任何内容之前）。
		expect(store.query({})[0]!.type).toBe("SESSION_CREATED");
		// 活跃代理订阅者（reactor / facade → 前端）收到扇出。
		expect(seen).toContain("SESSION_CREATED");
	});

	it("createThread (new_session RPC path) emits SESSION_CREATED", () => {
		const { sessionManager, seen } = setup();

		const thread = sessionManager.createThread();

		expect(seen).toContain("SESSION_CREATED");
		expect(sessionManager.getActiveSessionId()).toBe(thread.thread_id);
	});

	it("forkAtFromActive appends SESSION_FORKED after the copied prefix", () => {
		const { files, say, seen } = setup();
		const sourceHeader = files.createSession({ created_by: "user_explicit" });
		say("m1");
		say("m2");
		say("m3");
		const sourceStore = files.openStore(sourceHeader.session_id);
		const sourceId = sourceHeader.session_id;
		const sourceMessages = sourceStore.query({ types: ["USER_MESSAGE"] });
		const cutId = sourceMessages[1]!.event_id;
		seen.length = 0;

		const forkedHeader = files.forkAtFromActive(cutId);

		const forkStore = files.openStore(forkedHeader.session_id);
		const all = forkStore.query({});
		// 前缀复制保 id：复制的是 ≤cut 的两条消息（m1、m2）。
		expect(all.filter((e) => e.type === "USER_MESSAGE").map((e) => e.event_id)).toEqual(
			sourceMessages.slice(0, 2).map((e) => e.event_id),
		);
		const forked = forkStore.query({ types: ["SESSION_FORKED"] });
		expect(forked).toHaveLength(1);
		expect(forked[0]!.payload).toMatchObject({
			new_session_id: forkedHeader.session_id,
			parent_session_id: sourceId,
			fork_at_event_id: cutId,
		});
		// 复制（保序保 sequence）之后才发 FORKED —— 落在新库尾部。
		expect(all[all.length - 1]!.type).toBe("SESSION_FORKED");
		// fork 路径不为新会话发 SESSION_CREATED（v1 语义：只有显式新建才发）。
		// 前缀复制会把父会话自己的创建记录带过来（保 id 忠实复制），不算。
		expect(
			forkStore
				.query({ types: ["SESSION_CREATED"] })
				.filter((e) => (e.payload as { session_id?: string }).session_id === forkedHeader.session_id),
		).toHaveLength(0);
		expect(seen).toContain("SESSION_FORKED");
	});

	it("forkFrom emits SESSION_FORKED with and without copied history", () => {
		const { files, say } = setup();
		const sourceHeader = files.createSession({ created_by: "user_explicit", name: "src" });
		const sourceId = sourceHeader.session_id;
		say("a");
		say("b");
		const sourceHead = files.openStore(sourceId).head!;

		// preserveHistory=true：完整日志复制，FORKED 在复制之后。
		const withHistory = files.forkFrom(sourceId);
		const whStore = files.openStore(withHistory.session_id);
		const whAll = whStore.query({});
		expect(whAll.filter((e) => e.type === "USER_MESSAGE").map((e) => e.payload)).toHaveLength(2);
		const whForked = whStore.query({ types: ["SESSION_FORKED"] });
		expect(whForked).toHaveLength(1);
		expect(whForked[0]!.payload).toMatchObject({
			new_session_id: withHistory.session_id,
			parent_session_id: sourceId,
			fork_at_event_id: sourceHead,
		});
		expect(whAll[whAll.length - 1]!.type).toBe("SESSION_FORKED");

		// preserveHistory=false：空库只带 FORKED 标记。
		const withoutHistory = files.forkFrom(sourceId, { preserveHistory: false });
		const nohStore = files.openStore(withoutHistory.session_id);
		const nohAll = nohStore.query({});
		expect(nohAll).toHaveLength(1);
		expect(nohAll[0]!.type).toBe("SESSION_FORKED");
		expect(nohAll[0]!.payload).toMatchObject({ parent_session_id: sourceId });
	});

	it("jumpToSession emits SESSION_JUMPED into the reopened store; no-op jump emits nothing", () => {
		const { sessionManager, files, say, seen } = setup();
		const a = sessionManager.createSession("user_explicit", "A");
		say("for A");
		const b = sessionManager.createSession("user_explicit", "B");
		say("for B");
		seen.length = 0;

		const result = sessionManager.jumpToSession(a.session_id, "reopen");
		expect(result.reopened).toBe(true);

		const aStore = files.openStore(a.session_id);
		const jumped = aStore.query({ types: ["SESSION_JUMPED"] });
		expect(jumped).toHaveLength(1);
		expect(jumped[0]!.payload).toMatchObject({ target_session_id: a.session_id, reason: "reopen" });
		expect(seen).toContain("SESSION_JUMPED");

		// 目标即活跃会话：no-op，不产生事件。
		seen.length = 0;
		const again = sessionManager.jumpToSession(a.session_id);
		expect(again.reopened).toBe(false);
		expect(seen).toHaveLength(0);
		expect(aStore.query({ types: ["SESSION_JUMPED"] })).toHaveLength(1);
	});

	it("splitTailFrom copies the tail without emitting CREATED/FORKED into the new store", () => {
		const { files, say } = setup();
		const header = files.createSession({ created_by: "user_explicit" });
		say("m1");
		say("m2");
		say("m3");
		const sourceEvents = files.openStore(header.session_id).query({ types: ["USER_MESSAGE"] });
		// 从第二条消息起切分（话题切分语义：新会话带着触发消息继续）。
		const cut = sourceEvents[1]!.sequence;

		const splitHeader = files.splitTailFrom(cut);

		const splitStore = files.openStore(splitHeader.session_id);
		const moved = splitStore.query({ types: ["USER_MESSAGE"] });
		expect(moved.map((e) => e.event_id)).toEqual(sourceEvents.slice(1).map((e) => e.event_id));
		// 切分路径的信号由扩展追加 SESSION_BOUNDARY_INFERRED 负责，
		// 会话管理器本身不发 CREATED/FORKED。
		expect(splitStore.query({ types: ["SESSION_CREATED", "SESSION_FORKED"] })).toHaveLength(0);
		// 原库已截断。
		expect(files.openStore(header.session_id).query({ types: ["USER_MESSAGE"] })).toHaveLength(1);
	});

	it("forkFrom (preserveHistory:false) does not carry a dangling summary reference", () => {
		// v2 每会话一库后，preserveHistory:false fork 出的空库永远查不到源库
		// 的摘要事件（store.get 只查自己的库）——携带 summary_event_id 是
		// 永远 no-op 的悬空引用，不再新造。迁移数据的 header 字段保留（信息性）。
		const dir = mkdtempSync(join(tmpdir(), "zharness-summary-"));
		try {
			const storagePath = join(dir, "events.sqlite");
			const files = new SessionFileStoreManager("ws_summary", undefined, { storagePath });
			const source = files.createSession({ created_by: "user_explicit" });
			files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "m1" } });
			const summaryId = files.openStore(source.session_id).head!;
			// 模拟 v1 迁移产物：源 header 带指向源库内真实事件的摘要引用。
			const headerPath = join(files.root, source.session_id, "header.json");
			const header = JSON.parse(readFileSync(headerPath, "utf8")) as { summary_event_id?: string };
			header.summary_event_id = summaryId;
			writeFileSync(headerPath, JSON.stringify(header));
			files.dispose();

			const reopened = new SessionFileStoreManager("ws_summary", undefined, { storagePath });
			try {
				const branch = reopened.forkFrom(source.session_id, { preserveHistory: false });
				expect(branch.summary_event_id).toBeUndefined();
				// 空库分支：不复制源内容，只有 FORKED 标记。
				expect(reopened.openStore(branch.session_id).query({ types: ["USER_MESSAGE"] })).toHaveLength(0);
			} finally {
				reopened.dispose();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("constructing a manager (migration / active-pointer restore) emits nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "zharness-lifecycle-"));
		try {
			const storagePath = join(dir, "events.sqlite");
			const first = new SessionFileStoreManager("ws_disk", undefined, { storagePath });
			const header = first.createSession({ created_by: "user_explicit" });
			first.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept" } });
			const before = first.active.query({}).length;
			first.dispose();

			const seen: string[] = [];
			const second = new SessionFileStoreManager("ws_disk", undefined, { storagePath });
			second.active.subscribe((event) => seen.push(event.type));

			expect(second.activeSessionId).toBe(header.session_id);
			expect(second.active.query({}).length).toBe(before);
			expect(seen).toHaveLength(0);
			second.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
