/**
 * proactive-assistant 建议状态（进程内单例）。
 *
 * 与 context-editor 的 state.ts 同一模式：扩展工厂（事件面）与 RPC 数据面
 * import 同一模块，共享一份内存状态。建议描述的是「当下」——不落盘，
 * sidecar 重启即清空。
 *
 * 生命周期：active → dismissed | applied | expired
 * - dismissed ：用户主动关闭。
 * - applied   ：用户执行了建议动作（compact/steer/…）。
 * - expired   ：新用户消息到达时 knowledge_offer 自动失效（用户已在推进
 *               对话，沉淀提议不再合时宜）；stuck 类保留到轮次结束。
 *
 * 打扰控制：
 * - 冷却：同一 kind 的建议在 cooldownMs 内不重复产生。
 * - 容量：active 上限 MAX_ACTIVE，超出移除最旧。
 * - 免打扰：mutedUntil 之前不产生新建议（已有建议仍可见可操作）。
 */

import { randomUUID } from "node:crypto";
import type { AssistantSuggestion, SuggestionKind } from "./types.js";

/** 同 kind 建议的冷却时间（毫秒）。 */
const COOLDOWN_MS = 5 * 60 * 1000;
/** 同时保留的 active 建议上限。 */
const MAX_ACTIVE = 3;

export type StoreEvent =
	| { event: "added"; id: string }
	| { event: "removed"; id: string }
	| { event: "updated"; id: string }
	| { event: "cleared" };

interface MutableState {
	loaded: boolean;
	suggestions: AssistantSuggestion[];
	/** kind → 上次产生时间（冷却）。 */
	lastProducedAt: Map<SuggestionKind, number>;
	/** 免打扰截止时间戳（epoch ms）。 */
	mutedUntil: number;
	/** 本会话是否已提示过知识沉淀（一次性）。 */
	knowledgeOffered: boolean;
	/** 会话内用户轮数。 */
	userTurns: number;
	/** 会话累计工具调用/失败次数（知识草稿统计用）。 */
	totalToolCalls: number;
	totalToolFailures: number;
	/** 变更回调（index.ts 注册：广播 CUSTOM_MESSAGE）。 */
	listener: ((e: StoreEvent) => void) | undefined;
}

const state: MutableState = {
	loaded: false,
	suggestions: [],
	lastProducedAt: new Map(),
	mutedUntil: 0,
	knowledgeOffered: false,
	userTurns: 0,
	totalToolCalls: 0,
	totalToolFailures: 0,
	listener: undefined,
};

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export function markProactiveAssistantLoaded(): void {
	state.loaded = true;
}

export function isProactiveAssistantLoaded(): boolean {
	return state.loaded;
}

/** 注册状态变更回调（返回取消函数）。 */
export function onStoreChange(listener: (e: StoreEvent) => void): () => void {
	state.listener = listener;
	return () => {
		if (state.listener === listener) state.listener = undefined;
	};
}

// ---------------------------------------------------------------------------
// 查询面（RPC / TUI）
// ---------------------------------------------------------------------------

export function listActiveSuggestions(): AssistantSuggestion[] {
	return state.suggestions.map((s) => ({ ...s }));
}

export function getSuggestion(id: string): AssistantSuggestion | undefined {
	return state.suggestions.find((s) => s.id === id);
}

export function getMutedUntil(): number {
	return state.mutedUntil;
}

export function isMuted(): boolean {
	return Date.now() < state.mutedUntil;
}

export function getUserTurns(): number {
	return state.userTurns;
}

/** 会话累计工具统计（知识草稿展示「过程」用）。 */
export function getTotalToolStats(): { toolCalls: number; toolFailures: number } {
	return { toolCalls: state.totalToolCalls, toolFailures: state.totalToolFailures };
}

/** 记录一次工具执行结果（累计会话统计；轮内信号由 analyzer 自行累积）。 */
export function recordToolResult(isError: boolean): void {
	state.totalToolCalls += 1;
	if (isError) state.totalToolFailures += 1;
}

export function hasOfferedKnowledge(): boolean {
	return state.knowledgeOffered;
}

// ---------------------------------------------------------------------------
// 变更面（事件 hooks / RPC）
// ---------------------------------------------------------------------------

/**
 * 尝试登记一条新建议。冷却/免打扰/一次性标记在这里裁决；
 * 登记成功返回建议（含 id），否则返回 undefined。
 */
export function addSuggestion(
	input: Omit<AssistantSuggestion, "id" | "createdAt" | "sessionId">,
	sessionId: string,
	now: number = Date.now(),
): AssistantSuggestion | undefined {
	if (isMuted()) return undefined;

	// 同 kind 冷却：一条没消化完的同类建议不重复产生。
	const lastAt = state.lastProducedAt.get(input.kind);
	if (lastAt !== undefined && now - lastAt < COOLDOWN_MS) return undefined;

	// 同 kind 已有 active 建议时不叠加（旧建议仍在等用户处理）。
	if (state.suggestions.some((s) => s.kind === input.kind)) return undefined;

	if (input.kind === "knowledge_offer") {
		if (state.knowledgeOffered) return undefined;
		state.knowledgeOffered = true;
	}

	const suggestion: AssistantSuggestion = {
		...input,
		id: `pa_${randomUUID().slice(0, 8)}`,
		createdAt: now,
		sessionId,
	};
	state.lastProducedAt.set(input.kind, now);
	state.suggestions.push(suggestion);

	// 容量控制：移除最旧的 active 建议。
	while (state.suggestions.length > MAX_ACTIVE) {
		const removed = state.suggestions.shift();
		if (removed) state.listener?.({ event: "removed", id: removed.id });
	}
	state.listener?.({ event: "added", id: suggestion.id });
	return suggestion;
}

/** 用户关闭建议。 */
export function dismissSuggestion(id: string): boolean {
	const index = state.suggestions.findIndex((s) => s.id === id);
	if (index === -1) return false;
	const [removed] = state.suggestions.splice(index, 1);
	state.listener?.({ event: "removed", id: removed.id });
	return true;
}

/** 建议动作已执行：移除建议并留下 applied 语义（不留 active）。 */
export function markApplied(id: string): boolean {
	return dismissSuggestion(id);
}

/** 新用户消息到达：knowledge_offer 过期；用户轮数 +1。 */
export function onUserTurnStarted(): void {
	state.userTurns += 1;
	const expired = state.suggestions.filter((s) => s.kind === "knowledge_offer");
	state.suggestions = state.suggestions.filter((s) => s.kind !== "knowledge_offer");
	for (const s of expired) {
		state.listener?.({ event: "removed", id: s.id });
	}
}

/** 免打扰 N 分钟。 */
export function mute(minutes: number): number {
	const until = Date.now() + Math.max(0, Math.round(minutes)) * 60 * 1000;
	state.mutedUntil = until;
	return until;
}

/** 清空全部建议（/assistant clear、调试）。 */
export function clearSuggestions(): void {
	state.suggestions = [];
	state.listener?.({ event: "cleared" });
}

/** 测试钩子：恢复出厂。 */
export function resetStoreForTest(): void {
	state.loaded = false;
	state.suggestions = [];
	state.lastProducedAt.clear();
	state.mutedUntil = 0;
	state.knowledgeOffered = false;
	state.userTurns = 0;
	state.totalToolCalls = 0;
	state.totalToolFailures = 0;
	state.listener = undefined;
}
