/**
 * knowledge-forge 会话扫描。
 *
 * 按时间窗枚举本机全部（或指定）工作区的会话，把「用户说了什么 / 助手得出
 * 什么结论 / 干了什么 / 传了什么附件」压缩成一份供 LLM 分析的材料包：
 *   - 跳过定时任务脚手架会话（"scheduled: " 前缀）与本插件自己的派发消息，
 *     避免沉淀器消化自己昨天的产出（自反馈循环）；
 *   - 每个会话提取 USER_MESSAGE / AGENT_MESSAGE_END / TOOL_EXECUTION_END，
 *     附件图片按数量与所在消息位置记为元信息；
 *   - 尺寸预算：单会话与总量双重截断，新材料优先（按窗口内最后活动排序）。
 *
 * 扫描是只读的：对每个工作区短暂打开 events.sqlite 再关闭（与
 * session-listing.listAllSessionsLight 同一模式，跨进程读已验证安全）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { SessionFileStoreManager } from "../../core/event-store/session-files.js";
import { getEventDatabasePath } from "../../core/event-store/workspace.js";
import type { SqliteEventStore } from "../../core/event-store/sqlite-store.js";
import type { EventType } from "../../core/event-store/types.js";
import type { SessionDescriptor } from "../../core/projection/types.js";
import { readWorkspaceCwd } from "../../core/scheduler/store.js";
import type { ScanWindow } from "./config.js";

/** 单个会话（窗口内）的提取结果。 */
export interface ConversationDigest {
	workspaceId: string;
	workspaceCwd: string;
	sessionId: string;
	sessionName: string | undefined;
	title: string;
	firstActivityAt: number;
	lastActivityAt: number;
	userMessages: string[];
	assistantConclusions: string[];
	toolCalls: number;
	toolErrors: number;
	topTools: string[];
	imagesAttached: number;
}

export interface ScanResult {
	since: number;
	until: number;
	conversations: ConversationDigest[];
	truncated: boolean;
}

export interface ScanOptions {
	/** 只扫这些工作区（如仅当前工作区）；缺省扫全部。 */
	workspaceIds?: string[];
	/** 数据根目录（测试注入）。 */
	agentDir?: string;
	/** 时钟注入。 */
	now?: number;
	/** 窗口毫秒数（调用方由 ScanWindow 换算）。 */
	windowMs: number;
	/** 单会话提取的字符预算。 */
	perSessionBudget?: number;
	/** 总字符预算。 */
	totalBudget?: number;
}

/** 我们的派发 prompt 开头标记：扫描时按它剔除知识/技能任务自身的对话。 */
export const DIGEST_PROMPT_MARKER = "【knowledge-forge";

const SCHEDULED_PREFIX = "scheduled: ";
const DEFAULT_PER_SESSION_BUDGET = 4000;
const DEFAULT_TOTAL_BUDGET = 80_000;
/** 单条消息/结论的截断长度。 */
const ITEM_MAX_CHARS = 400;

/** 提取事件 content（string 或 blocks）里的纯文本。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && "text" in block
				? String((block as { text: unknown }).text)
				: "",
		)
		.join(" ");
}

function cap(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isScheduledScaffold(desc: SessionDescriptor): boolean {
	return desc.name !== undefined && desc.name.startsWith(SCHEDULED_PREFIX);
}

/** 列出 agentDir 下存在的 workspace 目录 id。 */
export function listWorkspaceIds(agentDir: string = getAgentDir()): string[] {
	const root = join(agentDir, "workspaces");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter(
			(e) =>
				e.isDirectory() &&
				// v2 会话库（sessions/）或旧版大库任一存在即算有效工作区。
				(existsSync(getEventDatabasePath(e.name, agentDir)) ||
					existsSync(join(getEventDatabasePath(e.name, agentDir), "..", "sessions"))),
		)
		.map((e) => e.name);
}

interface RawPick {
	ts: number;
	user: string;
	assistant: string;
	tool: string | undefined;
	toolError: boolean;
	images: number;
}

/** 查询一个会话窗口内的事件并压成原始条目（不截断预算）。 */
function pickSessionEvents(
	store: SqliteEventStore,
	desc: SessionDescriptor,
	since: number,
	until: number,
): RawPick[] {
	const start = desc.event_range.start_event_id === "ORIGIN" ? undefined : desc.event_range.start_event_id;
	const end = desc.event_range.end_event_id === "HEAD" ? undefined : desc.event_range.end_event_id;
	const filter: {
		types: EventType[];
		after?: string;
		before?: string;
		thread_id?: string;
		limit: number;
	} = { types: ["USER_MESSAGE", "AGENT_MESSAGE_END", "TOOL_EXECUTION_END"], limit: 5000 };
	if (start) filter.after = start;
	if (end) filter.before = end;
	if (desc.thread_id) filter.thread_id = desc.thread_id;

	const picks: RawPick[] = [];
	for (const event of store.query(filter)) {
		if (event.timestamp < since || event.timestamp > until) continue;
		const payload = event.payload as {
			content?: unknown;
			images?: unknown[];
			toolName?: unknown;
			isError?: unknown;
		};
		if (event.type === "USER_MESSAGE") {
			const text = extractText(payload.content);
			// 剔除本插件自身的派发消息（防自反馈）与空消息。
			if (!text.trim() || text.startsWith(DIGEST_PROMPT_MARKER)) continue;
			picks.push({
				ts: event.timestamp,
				user: text,
				assistant: "",
				tool: undefined,
				toolError: false,
				images: Array.isArray(payload.images) ? payload.images.length : 0,
			});
		} else if (event.type === "AGENT_MESSAGE_END") {
			const text = extractText(payload.content);
			if (!text.trim()) continue;
			picks.push({
				ts: event.timestamp,
				user: "",
				assistant: text,
				tool: undefined,
				toolError: false,
				images: 0,
			});
		} else if (event.type === "TOOL_EXECUTION_END") {
			picks.push({
				ts: event.timestamp,
				user: "",
				assistant: "",
				tool: typeof payload.toolName === "string" ? payload.toolName : undefined,
				toolError: payload.isError === true,
				images: 0,
			});
		}
	}
	return picks;
}

/** 把原始条目压成一条会话摘要（应用单会话预算）。 */
function buildConversationDigest(
	workspaceId: string,
	workspaceCwd: string,
	desc: SessionDescriptor,
	picks: RawPick[],
	budget: number,
): ConversationDigest {
	const userMessages: string[] = [];
	const assistantConclusions: string[] = [];
	const toolCounts = new Map<string, number>();
	let toolCalls = 0;
	let toolErrors = 0;
	let images = 0;
	let used = 0;

	for (const pick of picks) {
		if (pick.user) {
			if (used < budget) {
				const capped = cap(pick.user, ITEM_MAX_CHARS);
				userMessages.push(capped);
				used += capped.length;
			}
			images += pick.images;
		} else if (pick.assistant) {
			if (used < budget) {
				const capped = cap(pick.assistant, ITEM_MAX_CHARS);
				assistantConclusions.push(capped);
				used += capped.length;
			}
		} else if (pick.tool) {
			toolCalls += 1;
			if (pick.toolError) toolErrors += 1;
			toolCounts.set(pick.tool, (toolCounts.get(pick.tool) ?? 0) + 1);
		}
	}

	const timestamps = picks.map((p) => p.ts);
	const title = desc.name ?? (userMessages[0] ? cap(userMessages[0], 60) : `会话 ${desc.session_id}`);
	const topTools = Array.from(toolCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([name, count]) => `${name}×${count}`);

	return {
		workspaceId,
		workspaceCwd,
		sessionId: desc.session_id,
		sessionName: desc.name,
		title,
		firstActivityAt: Math.min(...timestamps),
		lastActivityAt: Math.max(...timestamps),
		userMessages,
		assistantConclusions,
		toolCalls,
		toolErrors,
		topTools,
		imagesAttached: images,
	};
}

/** 扫描窗口内的会话材料。 */
export function scanSessions(options: ScanOptions): ScanResult {
	const now = options.now ?? Date.now();
	const since = now - options.windowMs;
	const perSession = options.perSessionBudget ?? DEFAULT_PER_SESSION_BUDGET;
	const totalBudget = options.totalBudget ?? DEFAULT_TOTAL_BUDGET;
	const agentDir = options.agentDir ?? getAgentDir();
	const workspaceIds =
		options.workspaceIds && options.workspaceIds.length > 0
			? options.workspaceIds
			: listWorkspaceIds(agentDir);

	const collected: { digest: ConversationDigest; last: number }[] = [];
	for (const workspaceId of workspaceIds) {
		// v2 每会话一库：经 manager 枚举 header（同时触发旧库幂等迁移），
		// 逐会话打开它自己的库扫描。用完即 dispose —— 缓存的 sqlite 句柄
		// 不关会让常驻进程泄漏（Windows 上还锁死会话目录）。
		const manager = new SessionFileStoreManager(workspaceId, agentDir);
		try {
			const workspaceCwd = readWorkspaceCwd(workspaceId) ?? "";
			for (const header of manager.listSessions()) {
				const desc = {
					session_id: header.session_id,
					// thread_id 留空：v2 事件行不落线程标签，库本身即隔离边界。
					workspace_id: workspaceId,
					event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
					created_by: header.created_by,
					name: header.title,
					parent_session_id: header.parent_session_id,
					created_at: header.created_at,
				} as SessionDescriptor;
				// 脚手架会话与远早于窗口的会话直接跳过（省一次查询）。
				if (isScheduledScaffold(desc)) continue;
				if (header.created_at < since - 24 * 3600_000) continue;
				let picks: RawPick[] = [];
				try {
					picks = pickSessionEvents(manager.openStore(header.session_id), desc, since, now);
				} catch {
					continue;
				}
				if (picks.length === 0) continue;
				collected.push({
					digest: buildConversationDigest(workspaceId, workspaceCwd, desc, picks, perSession),
					last: Math.max(...picks.map((p) => p.ts)),
				});
			}
		} finally {
			manager.dispose();
		}
	}

	// 新活动优先；超出总预算的旧会话丢弃并标记 truncated。
	collected.sort((a, b) => b.last - a.last);
	const conversations: ConversationDigest[] = [];
	let used = 0;
	let truncated = false;
	for (const { digest } of collected) {
		const size =
			digest.userMessages.join("").length + digest.assistantConclusions.join("").length;
		if (used + size > totalBudget) {
			truncated = true;
			continue;
		}
		used += size;
		conversations.push(digest);
	}
	return { since, until: now, conversations, truncated };
}

/** 把扫描结果渲染成给 LLM 的 markdown 材料包。 */
export function renderScanResult(result: ScanResult, windowLabelText: string): string {
	const lines: string[] = [];
	lines.push(`# 会话材料（回看 ${windowLabelText}，共 ${result.conversations.length} 段对话${result.truncated ? "，已按预算截断" : ""}）`);
	lines.push("");
	for (const c of result.conversations) {
		const when = new Date(c.lastActivityAt).toISOString().slice(0, 16).replace("T", " ");
		lines.push(`## ${c.title}`);
		lines.push(
			`- 工作区: ${c.workspaceId}${c.workspaceCwd ? `（${c.workspaceCwd}）` : ""} · 会话 ${c.sessionId} · 最近活动 ${when}（UTC）`,
		);
		lines.push(
			`- 活动统计: 工具调用 ${c.toolCalls} 次（失败 ${c.toolErrors}）` +
				(c.topTools.length ? `，主要工具 ${c.topTools.join("、")}` : "") +
				(c.imagesAttached ? `，附件图片 ${c.imagesAttached} 张` : ""),
		);
		if (c.userMessages.length) {
			lines.push("- 用户消息:");
			for (const m of c.userMessages) lines.push(`  - ${m}`);
		}
		if (c.assistantConclusions.length) {
			lines.push("- 助手结论:");
			for (const m of c.assistantConclusions.slice(-8)) lines.push(`  - ${m}`);
		}
		lines.push("");
	}
	if (result.conversations.length === 0) {
		lines.push("（窗口内没有可分析的会话内容。）");
	}
	return lines.join("\n");
}
