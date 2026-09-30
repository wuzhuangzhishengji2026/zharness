/**
 * Tests for the sidebar session grouping (listAllSessionsLight, v2 每会话
 * 一库):
 *
 * 1. 同谱系（parent 指针相连的 rewind 分支/续写）聚合为一行，session_ids
 *    列出全部成员 —— GUI 据此把定时任务卡片锚定到整行对话。
 * 2. 行的 title 来自 header（首条用户消息落库时写好），不再现场探测。
 * 3. 定时任务会话(kind/name 前缀)派发过即对用户可见;仅空壳(从未派发)
 *    不进侧栏。
 * 4. 重启后活跃指针恢复到用户离开时的对话。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureWorkspaceMeta } from "../src/core/event-store/workspace.js";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { listAllSessionsLight } from "../src/core/session-listing.js";

let agentDir: string;
let files: SessionFileStoreManager;
let manager: SessionManager;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "zharness-session-listing-"));
	ensureWorkspaceMeta("ws-list", "/project/dir", agentDir);
	files = new SessionFileStoreManager("ws-list", agentDir, { cwd: "/project/dir" });
	manager = new SessionManager(files);
});

afterEach(() => {
	manager.dispose();
	try {
		rmSync(agentDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const say = (text: string): void => {
	files.active.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: text } });
};

describe("listAllSessionsLight (sidebar conversation grouping, v2)", () => {
	it("aggregates a fork lineage into one row", () => {
		const s1 = manager.getActiveSession().getDescriptor();
		say("hello world");

		// 用户从 s1 派生续写分支（fork 复制整库，parent 指回 s1）。
		const s2 = manager.forkFromSession(s1.session_id);
		files.setActive(s2.session_id);
		say("continue the convo");

		const summaries = listAllSessionsLight(agentDir);
		const row = summaries.find((s) => s.session_ids?.includes(s1.session_id));
		expect(row).toBeDefined();
		expect(row!.session_ids).toEqual(expect.arrayContaining([s1.session_id, s2.session_id]));
		expect(summaries.filter((s) => s.session_ids?.includes(s1.session_id))).toHaveLength(1);
		expect(row!.title).toBe("hello world");
	});

	it("keeps separate conversations in separate rows", () => {
		const first = manager.getActiveSession().getDescriptor();
		say("conversation one");
		const second = manager.createSession("user_explicit");
		say("conversation two");

		const summaries = listAllSessionsLight(agentDir);
		expect(summaries).toHaveLength(2);
		const one = summaries.find((s) => s.session_ids?.includes(first.session_id))!;
		const two = summaries.find((s) => s.session_ids?.includes(second.session_id))!;
		expect(one.title).toBe("conversation one");
		expect(two.title).toBe("conversation two");
	});

	it("shows dispatched scheduled-task sessions in the sidebar, hides empty scaffolds", () => {
		const user = manager.getActiveSession().getDescriptor();
		say("user chat");

		// 调度器在独立会话库派发任务(kind: "scheduled")——派发过的会话有
		// 任务消息,用户要能在侧栏找到它。
		const scheduled = files.createSession({
			name: "scheduled: nightly report",
			created_by: "user_explicit",
			kind: "scheduled",
		});
		files.setActive(scheduled.session_id);
		say("run the nightly build report");

		// 空壳:创建后从未成功派发(无任何用户消息),仍不进侧栏。
		const empty = files.createSession({
			name: "scheduled: never dispatched",
			created_by: "user_explicit",
			kind: "scheduled",
		});
		files.setActive(user.session_id);

		const summaries = listAllSessionsLight(agentDir);
		const scheduledRow = summaries.find((s) => s.session_id === scheduled.session_id);
		expect(scheduledRow).toBeDefined();
		expect(scheduledRow!.name).toBe("scheduled: nightly report");
		expect(summaries.some((s) => s.session_id === empty.session_id)).toBe(false);
		const userRow = summaries.find((s) => s.session_id === user.session_id);
		expect(userRow).toBeDefined();
		expect(userRow!.title).toBe("user chat");
	});

	it("restores the active pointer after restart (no scheduled resume)", () => {
		const user = manager.getActiveSession().getDescriptor();
		say("user chat");

		const scheduled = files.createSession({
			name: "scheduled: nightly report",
			created_by: "user_explicit",
			kind: "scheduled",
		});
		files.setActive(scheduled.session_id);
		// 调度器派发后恢复用户的活跃会话。
		files.setActive(user.session_id);
		manager.dispose();

		const restarted = new SessionManager(new SessionFileStoreManager("ws-list", agentDir, { cwd: "/project/dir" }));
		expect(restarted.getActiveSessionId()).toBe(user.session_id);
		restarted.dispose();
	});
});
