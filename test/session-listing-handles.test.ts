import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import { deriveWorkspaceId, ensureWorkspaceMeta } from "../src/core/event-store/workspace.js";
import { listAllSessionsLight, listWorkspaceSessions } from "../src/core/session-listing.js";

/**
 * 会话列举不得泄漏 sqlite 句柄（v2 每会话一库的配套约束）。
 *
 * listWorkspaceSessions / listAllSessionsLight / --rewind 的目标解析都会
 * 构造 SessionFileStoreManager 开库读数据。桌面端 sidecar 是常驻进程：
 * 句柄不关，侧栏每次刷新都漏一批打开的 sqlite 文件；Windows 上被打开的
 * 文件无法删除 —— 这里用「列举后临时目录可整体删除」作为泄漏探测器
 * （Windows 上失败即泄漏；POSIX 上 rm 恒成功，测试退化为冒烟）。
 */

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 尽力清理 */
		}
	}
});

function makeWorkspace(): { root: string; agentDir: string; projectDir: string; workspaceId: string } {
	const root = mkdtempSync(join(tmpdir(), "zharness-listing-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const workspaceId = deriveWorkspaceId(projectDir);
	ensureWorkspaceMeta(workspaceId, projectDir, agentDir);
	return { root, agentDir, projectDir, workspaceId };
}

function seedSession(agentDir: string, projectDir: string, workspaceId: string): void {
	const files = new SessionFileStoreManager(workspaceId, agentDir, { cwd: projectDir });
	try {
		const header = files.createSession({ created_by: "user_explicit", name: "seeded" });
		files.openStore(header.session_id).append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "seed message" },
		});
	} finally {
		files.dispose();
	}
}

describe("session listing releases sqlite handles", () => {
	it("listWorkspaceSessions does not keep the session db open", async () => {
		const { root, agentDir, projectDir, workspaceId } = makeWorkspace();
		seedSession(agentDir, projectDir, workspaceId);

		const sessions = await listWorkspaceSessions(projectDir, agentDir);
		expect(sessions.length).toBeGreaterThan(0);

		rmSync(root, { recursive: true, force: true });
		expect(existsSync(join(root, "agent"))).toBe(false);
	});

	it("listAllSessionsLight does not keep the session db open", () => {
		const { root, agentDir, projectDir, workspaceId } = makeWorkspace();
		seedSession(agentDir, projectDir, workspaceId);

		const summaries = listAllSessionsLight(agentDir);
		expect(summaries.length).toBeGreaterThan(0);

		rmSync(root, { recursive: true, force: true });
		expect(existsSync(join(root, "agent"))).toBe(false);
	});
});
