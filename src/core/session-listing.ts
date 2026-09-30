/**
 * Session Listing (v2: per-session event stores)
 *
 * 侧栏/列表从每会话 header.json 读取 —— 标题在落库时写好（首条用户消息
 * 或用户命名），不再对事件日志做现场探测/聚合。旧"一工作区一大库"由
 * SessionFileStoreManager.ensureMigrated 幂等迁移，本模块只见新布局。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, Message } from "./agent/types.js";
import { getAgentDir } from "../config.js";
import { SessionFileStoreManager, type SessionFileHeader } from "./event-store/session-files.js";
import { deriveWorkspaceId, getWorkspaceMetaPath } from "./event-store/workspace.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionListInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

// ============================================================================
// Helpers
// ============================================================================

const SESSION_REF_PREFIX = "event-session:";

function makeSessionRef(workspaceId: string, sessionId: string): string {
	return `${SESSION_REF_PREFIX}${workspaceId}:${sessionId}`;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

/** Read workspace cwd from meta.json */
function readWorkspaceCwd(workspaceId: string, agentDir: string): string | undefined {
	const metaPath = getWorkspaceMetaPath(workspaceId, agentDir);
	if (!existsSync(metaPath)) return undefined;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
		return meta.cwd;
	} catch {
		return undefined;
	}
}

/**
 * 定时任务会话的可见性:「scheduled: 」前缀 / kind:"scheduled" 标识来源,
 * 但不再一律隐藏——任务「每次新会话」的运行结果就是这些会话,用户要在
 * 侧栏找到它们。只过滤空壳:创建后从未成功派发(没有任何用户消息)的
 * 占位会话不进列表。
 */
function isUnrunScaffold(header: SessionFileHeader, manager: SessionFileStoreManager): boolean {
	const scheduled = header.kind === "scheduled" || (header.title?.startsWith("scheduled: ") ?? false);
	if (!scheduled) return false;
	return !manager.firstUserMessage(header.session_id);
}

// ============================================================================
// Public API
// ============================================================================

function headerToListInfo(
	header: SessionFileHeader,
	workspaceId: string,
	cwd: string,
	manager: SessionFileStoreManager,
): SessionListInfo {
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	try {
		const store = manager.openStore(header.session_id);
		for (const event of store.query({ types: ["USER_MESSAGE", "AGENT_MESSAGE_END"] })) {
			messageCount++;
			if (event.type === "USER_MESSAGE") {
				const payload = event.payload as { content?: string };
				const text = typeof payload.content === "string" ? payload.content : "";
				if (text && !firstMessage) firstMessage = text.slice(0, 200);
				if (text) allMessages.push(text);
			}
		}
	} catch {
		/* 库缺失按空会话处理 */
	}
	return {
		path: makeSessionRef(workspaceId, header.session_id),
		id: header.session_id,
		cwd,
		name: header.title,
		parentSessionPath: header.parent_session_id
			? makeSessionRef(workspaceId, header.parent_session_id)
			: undefined,
		created: new Date(header.created_at),
		modified: new Date(header.created_at),
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

/**
 * List all sessions for a workspace (current cwd), from per-session headers.
 */
export async function listWorkspaceSessions(
	cwd: string,
	agentDir: string = getAgentDir(),
	onProgress?: SessionListProgress,
): Promise<SessionListInfo[]> {
	const workspaceId = deriveWorkspaceId(cwd);
	// 用完即 dispose：manager 缓存打开的 sqlite 句柄，sidecar 是常驻进程，
	// 不关的话每次列举泄漏一批句柄（Windows 上还会锁死会话目录）。
	const manager = new SessionFileStoreManager(workspaceId, agentDir, { cwd });
	try {
		const headers = manager.listSessions().filter((h) => !isUnrunScaffold(h, manager));
		const workspaceCwd = readWorkspaceCwd(workspaceId, agentDir) ?? cwd;
		const results: SessionListInfo[] = [];
		for (let i = 0; i < headers.length; i++) {
			results.push(headerToListInfo(headers[i]!, workspaceId, workspaceCwd, manager));
			onProgress?.(i + 1, headers.length);
		}
		results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return results;
	} finally {
		manager.dispose();
	}
}

/**
 * List all sessions across all workspaces, from per-session headers.
 */
export async function listAllSessions(
	agentDir: string = getAgentDir(),
	onProgress?: SessionListProgress,
): Promise<SessionListInfo[]> {
	const workspacesDir = join(agentDir, "workspaces");
	if (!existsSync(workspacesDir)) return [];

	const workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	const results: SessionListInfo[] = [];
	for (let i = 0; i < workspaceEntries.length; i++) {
		const workspaceId = workspaceEntries[i]!;
		const manager = new SessionFileStoreManager(workspaceId, agentDir);
		try {
			const workspaceCwd = readWorkspaceCwd(workspaceId, agentDir) ?? process.cwd();
			for (const header of manager.listSessions()) {
				if (isUnrunScaffold(header, manager)) continue;
				results.push(headerToListInfo(header, workspaceId, workspaceCwd, manager));
			}
		} finally {
			manager.dispose();
		}
		onProgress?.(i + 1, workspaceEntries.length);
	}
	results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return results;
}

// ============================================================================
// Lightweight listing (GUI sidebar)
// ============================================================================

/**
 * Lightweight per-session summary for the GUI sidebar: conversations mapped
 * under their workspace (project). One row per lineage (谱系): header 的
 * parent 指针把 rewind 分支/续写归并到同一根 —— 显式指针分组，零猜测。
 */
export interface WorkspaceSessionSummary {
	workspace_id: string;
	cwd: string;
	session_id: string;
	/** 同谱系内全部会话 id（定时任务卡片锚定整行对话用）。 */
	session_ids?: string[];
	name?: string;
	/** Display title: user-given name, else first user message, else "". */
	title: string;
	created_at: number;
	/** Representative session's parent (fork source), when present. */
	parent_session_id?: string;
}

function buildSessionSummaries(
	workspaceId: string,
	cwd: string,
	manager: SessionFileStoreManager,
): WorkspaceSessionSummary[] {
	const headers = manager.listSessions().filter((h) => !isUnrunScaffold(h, manager));
	const byId = new Map(headers.map((h) => [h.session_id, h]));

	// 分组键 = 谱系根（沿 parent 链回溯）。
	const rootOf = (header: SessionFileHeader): string => {
		let cur = header;
		const seen = new Set<string>();
		while (cur.parent_session_id && !seen.has(cur.parent_session_id)) {
			seen.add(cur.parent_session_id);
			const parent = byId.get(cur.parent_session_id);
			if (!parent) return cur.parent_session_id;
			cur = parent;
		}
		return cur.session_id;
	};

	interface Group {
		members: SessionFileHeader[];
	}
	const groups = new Map<string, Group>();
	for (const header of headers) {
		const key = rootOf(header);
		const group = groups.get(key) ?? { members: [] };
		group.members.push(header);
		groups.set(key, group);
	}

	const summaries: WorkspaceSessionSummary[] = [];
	for (const [rootId, group] of groups) {
		const members = [...group.members].sort((a, b) => a.created_at - b.created_at);
		const root = byId.get(rootId) ?? members[0]!;
		// 代表 = 最新的有内容成员（点行查看有东西可看）。
		let rep = members[members.length - 1]!;
		for (let i = members.length - 1; i >= 0; i--) {
			const candidate = members[i]!;
			if (candidate.title || manager.firstUserMessage(candidate.session_id, 40)) {
				rep = candidate;
				break;
			}
		}
		const title = rep.title ?? root.title ?? manager.firstUserMessage(root.session_id) ?? "";
		summaries.push({
			workspace_id: workspaceId,
			cwd,
			session_id: rep.session_id,
			session_ids: members.map((m) => m.session_id),
			name: [...members].reverse().find((m) => m.title)?.title,
			title,
			created_at: members[0]!.created_at,
			parent_session_id: rep.parent_session_id,
		});
	}
	summaries.sort((a, b) => b.created_at - a.created_at);
	return summaries;
}

/** List sessions for EVERY workspace on disk (headers only, no event scans). */
export function listAllSessionsLight(agentDir: string = getAgentDir()): WorkspaceSessionSummary[] {
	const workspacesDir = join(agentDir, "workspaces");
	if (!existsSync(workspacesDir)) return [];

	const results: WorkspaceSessionSummary[] = [];
	for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manager = new SessionFileStoreManager(entry.name, agentDir);
		try {
			const cwd = readWorkspaceCwd(entry.name, agentDir) ?? "";
			results.push(...buildSessionSummaries(entry.name, cwd, manager));
		} catch {
			/* 单工作区异常不拖垮侧栏 */
		} finally {
			// 侧栏热路径（每次刷新调用）：句柄必须释放，否则常驻 sidecar 泄漏。
			manager.dispose();
		}
	}
	return results;
}
