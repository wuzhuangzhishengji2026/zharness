/**
 * 主动式交互助手的数据层。
 *
 * 数据由内置扩展 `proactive-assistant` 提供（src/builtin-extensions/proactive-assistant）：
 * - 建议与操作经 `proactive_assistant` RPC 读写扩展的内存状态；
 * - 变更经 CUSTOM_MESSAGE(display:false, kind=proactive_assistant_changed) 事件
 *   广播，收到后调用 `list` 拉全量（同任务看板「事件做提示、数据走 RPC」模式）；
 * - 知识沉淀：knowledge_draft 生成草稿 → 用户编辑 → knowledge_save 落入
 *   主 agent 记忆库（memory/*.md + _index.md）。
 */

import { sendCommandAwait, subscribeEvents } from "./transport";
import type {
	RpcAssistantAction,
	RpcAssistantKnowledgeDraft,
	RpcAssistantKnowledgeSaveResult,
	RpcAssistantStateData,
	RpcAssistantSuggestion,
} from "./types";

export type { RpcAssistantSuggestion, RpcAssistantAction };

/** sidecar 不可达时的空态（widget 降级为隐藏，不报错）。 */
const EMPTY_STATE: RpcAssistantStateData = {
	extensionLoaded: false,
	suggestions: [],
	mutedUntil: 0,
	userTurns: 0,
	knowledgeOffered: false,
};

async function callAssistant<T>(command: Record<string, unknown>): Promise<T | null> {
	try {
		const response = await sendCommandAwait<T>({
			type: "proactive_assistant",
			...command,
		});
		if (!response.success) {
			console.error("[assistant] proactive_assistant RPC failed:", response.error);
			return null;
		}
		return response.data ?? null;
	} catch (e) {
		console.error("[assistant] proactive_assistant RPC error:", e);
		return null;
	}
}

/** 拉取助手状态（active 建议 + 会话统计）。失败或数据形状异常时返回空态。 */
export async function listAssistantState(): Promise<RpcAssistantStateData> {
	const state = (await callAssistant<RpcAssistantStateData>({ action: "list" })) ?? EMPTY_STATE;
	// 形状防御：响应可能被传输层兜底错配成其它命令的数据（旧 sidecar 不回显
	// id 时），缺字段不能让 Widget 崩溃——逐字段校验后再交给 UI。
	return {
		extensionLoaded: Boolean(state.extensionLoaded),
		suggestions: Array.isArray(state.suggestions) ? state.suggestions : [],
		mutedUntil: typeof state.mutedUntil === "number" ? state.mutedUntil : 0,
		userTurns: typeof state.userTurns === "number" ? state.userTurns : 0,
		knowledgeOffered: Boolean(state.knowledgeOffered),
	};
}

/** 关闭一条建议。 */
export async function dismissSuggestion(id: string): Promise<boolean> {
	const r = await callAssistant<{ dismissed: boolean }>({ action: "dismiss", suggestionId: id });
	return r?.dismissed ?? false;
}

/** 执行建议的首个动作（compact / steer / continue）。 */
export async function applySuggestion(
	id: string,
): Promise<{ applied: boolean; action: RpcAssistantAction["kind"] } | null> {
	return callAssistant<{ applied: boolean; action: RpcAssistantAction["kind"] }>({
		action: "apply",
		suggestionId: id,
	});
}

/** 生成知识沉淀草稿（预填内容，用户编辑后另存）。 */
export async function draftKnowledge(suggestionId: string): Promise<RpcAssistantKnowledgeDraft | null> {
	return callAssistant<RpcAssistantKnowledgeDraft>({ action: "knowledge_draft", suggestionId });
}

/** 保存知识到主 agent 记忆库。 */
export async function saveKnowledge(input: {
	title: string;
	content: string;
	tags?: string[];
}): Promise<RpcAssistantKnowledgeSaveResult | null> {
	return callAssistant<RpcAssistantKnowledgeSaveResult>({
		action: "knowledge_save",
		title: input.title,
		content: input.content,
		tags: input.tags,
	});
}

/** 免打扰 N 分钟。 */
export async function muteAssistant(minutes: number): Promise<number> {
	const r = await callAssistant<{ mutedUntil: number }>({ action: "mute", minutes });
	return r?.mutedUntil ?? 0;
}

/**
 * 订阅助手状态变更（新建议出现/建议被处理时触发）。
 * 返回取消订阅函数（可直接作为 useEffect cleanup）。
 */
export function subscribeAssistantChanges(handler: () => void): () => void {
	let unlisten: (() => void) | undefined;
	void subscribeEvents((event) => {
		if (event.type !== "CUSTOM_MESSAGE") return;
		const payload = event.payload as { kind?: unknown; extension_id?: unknown } | undefined;
		if (payload?.extension_id === "proactive-assistant" && payload?.kind === "proactive_assistant_changed") {
			handler();
		}
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
}
