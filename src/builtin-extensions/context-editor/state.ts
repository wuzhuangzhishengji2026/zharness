/**
 * context-editor 覆盖状态（进程内单例）。
 *
 * 与 task-board 的 store.ts 同一模式：扩展工厂（hooks）与 RPC 数据面
 * （packages/rpc/rpc-mode.ts 的 context_preview / context_apply /
 * context_overrides_clear）import 同一个模块，共享一份内存状态。
 * 覆盖不落盘——它们描述的是「下一次/本会话后续请求」的临时语义，
 * sidecar 重启即清空。
 *
 * 两类覆盖，各自支持两种 scope：
 *
 * 1. 系统提示词覆盖（经 before_agent_start 每轮重新应用）
 *    - once      ：下一次发送（整轮，含其中的多次 LLM 调用）使用编辑后的
 *                  文本，下一轮自动恢复捕获的原提示词。
 *    - persistent：本会话后续每次发送都使用编辑后的文本，直到清除。
 *                  baseBeforePersistent 记录首次持续覆盖前的原文本，
 *                  供「清除」时恢复。
 *
 * 2. 消息编辑（经 context 事件在每次 LLM 调用前应用到投影消息上，
 *    按源事件 id 定位，事件日志本身不被修改）
 *    - once      ：仅下一次 LLM 请求生效，之后投影恢复原文。
 *    - persistent：本会话后续每次请求都生效，直到清除或该消息因
 *                  压缩/截断淡出上下文。
 */

import type { AgentMessage } from "../../core/agent/types.js";
import type { TextContent, ImageContent, ToolCall } from "@earendil-works/pi-ai/compat";

/** 覆盖生效范围：once = 仅下一次；persistent = 本会话后续每次。 */
export type OverrideScope = "once" | "persistent";

export interface SystemPromptOverride {
	text: string;
	scope: OverrideScope;
}

export type MessageEdit =
	| { action: "edit"; text: string; scope: OverrideScope }
	| { action: "delete"; scope: OverrideScope };

/** RPC 快照形态（可序列化）。 */
export interface ContextEditorSnapshot {
	loaded: boolean;
	systemPromptOverride?: SystemPromptOverride;
	/** once 消费后待恢复的原系统提示词。 */
	restoreBaseSystemPrompt?: string;
	/** 首次 persistent 覆盖前的原系统提示词，供清除时恢复。 */
	baseBeforePersistent?: string;
	messageEdits: Record<string, MessageEdit>;
}

interface MutableState {
	loaded: boolean;
	systemPromptOverride?: SystemPromptOverride;
	restoreBaseSystemPrompt?: string;
	baseBeforePersistent?: string;
	messageEdits: Map<string, MessageEdit>;
}

const state: MutableState = { loaded: false, messageEdits: new Map() };

function clonedState(): MutableState {
	return {
		loaded: state.loaded,
		systemPromptOverride: state.systemPromptOverride ? { ...state.systemPromptOverride } : undefined,
		restoreBaseSystemPrompt: state.restoreBaseSystemPrompt,
		baseBeforePersistent: state.baseBeforePersistent,
		messageEdits: new Map(state.messageEdits),
	};
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export function markContextEditorLoaded(): void {
	state.loaded = true;
}

export function markContextEditorUnloaded(): void {
	state.loaded = false;
}

export function isContextEditorLoaded(): boolean {
	return state.loaded;
}

// ---------------------------------------------------------------------------
// 系统提示词覆盖 —— 设置 / 清除
// ---------------------------------------------------------------------------

export function setSystemPromptOverride(text: string, scope: OverrideScope): void {
	state.systemPromptOverride = { text, scope };
}

export function clearSystemPromptOverride(): void {
	state.systemPromptOverride = undefined;
	state.restoreBaseSystemPrompt = undefined;
}

/** RPC 层在设置首个 persistent 覆盖时记录原文本；清除 persistent 时恢复用。 */
export function setBaseBeforePersistent(base: string | undefined): void {
	state.baseBeforePersistent = base;
}

/**
 * 状态转移：给定当前系统提示词，计算「下一次发送」实际生效的提示词。
 * 同一纯函数供两处使用：
 *  - before_agent_start handler：对真实 state 执行（消费型）；
 *  - context_preview RPC：对克隆 state 执行（预演型，不动状态）。
 *
 * 优先级：待消费的 once > 待恢复的还原 > persistent > 不变。
 */
function transition(s: MutableState, current: string): { result?: string } {
	if (s.systemPromptOverride?.scope === "once") {
		// 首次消费 once 时捕获当前提示词，供下一轮还原。
		if (s.restoreBaseSystemPrompt === undefined) {
			s.restoreBaseSystemPrompt = current;
		}
		const text = s.systemPromptOverride.text;
		s.systemPromptOverride = undefined;
		return { result: text };
	}
	if (s.restoreBaseSystemPrompt !== undefined) {
		// 还原轮。若期间用户设置了 persistent，还原被其取代（直接持续生效）。
		if (s.systemPromptOverride?.scope === "persistent") {
			s.restoreBaseSystemPrompt = undefined;
			return { result: s.systemPromptOverride.text };
		}
		const base = s.restoreBaseSystemPrompt;
		s.restoreBaseSystemPrompt = undefined;
		return { result: base };
	}
	if (s.systemPromptOverride?.scope === "persistent") {
		return { result: s.systemPromptOverride.text };
	}
	return {};
}

/** 预演：不改变状态，回答「如果现在发送，系统提示词会是什么」。 */
export function planSystemPromptForSend(current: string): { result?: string } {
	return transition(clonedState(), current);
}

/** 消费：before_agent_start 实际执行的状态转移。 */
export function consumeSystemPromptForSend(current: string): { result?: string } {
	return transition(state, current);
}

// ---------------------------------------------------------------------------
// 消息编辑 —— 设置 / 清除
// ---------------------------------------------------------------------------

export function setMessageEdit(eventId: string, edit: MessageEdit): void {
	state.messageEdits.set(eventId, edit);
}

export function clearMessageEdit(eventId: string): void {
	state.messageEdits.delete(eventId);
}

export function clearAllMessageEdits(): void {
	state.messageEdits.clear();
}

export function clearAllOverrides(): void {
	clearSystemPromptOverride();
	clearAllMessageEdits();
	state.baseBeforePersistent = undefined;
}

/**
 * 把消息编辑应用到一条投影消息上（按角色替换文本）。
 * - user：字符串直接替换；块数组则替换文本块、保留图片块。
 * - assistant：保留 toolCall 块（配对不能断），文本块替换为单一文本块，
 *   thinking 块随旧文本一并丢弃。
 * - toolResult：content 替换为单一文本块（toolCallId/toolName 不动）。
 * - 其余角色（bashExecution 等）不发送给 LLM，原样返回。
 */
export function replaceMessageText(message: AgentMessage, text: string): AgentMessage {
	switch (message.role) {
		case "user": {
			if (typeof message.content === "string") {
				return { ...message, content: text };
			}
			const images = message.content.filter((b): b is ImageContent => b.type === "image");
			const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
			return { ...message, content };
		}
		case "assistant": {
			const toolCalls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
			return { ...message, content: [{ type: "text", text }, ...toolCalls] };
		}
		case "toolResult": {
			return { ...message, content: [{ type: "text", text }] };
		}
		default:
			return message;
	}
}

/**
 * 对整段上下文应用消息编辑（context 事件与 preview 共用）。
 * 按源事件 id 定位；once 作用域的编辑在命中并应用后清除（消费），
 * dryRun=true 时仅预演不消费。
 */
export function applyMessageEditsToContext(
	messages: AgentMessage[],
	sourceEventIds: (string | undefined)[] | undefined,
	options?: { dryRun?: boolean },
): AgentMessage[] {
	if (state.messageEdits.size === 0) return messages;
	const out: AgentMessage[] = [];
	const consumedOnceIds: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const eventId = sourceEventIds?.[i];
		const edit = eventId ? state.messageEdits.get(eventId) : undefined;
		if (!eventId || !edit) {
			out.push(message);
			continue;
		}
		if (edit.action === "delete") {
			if (edit.scope === "once") consumedOnceIds.push(eventId);
			continue;
		}
		out.push(replaceMessageText(message, edit.text));
		if (edit.scope === "once") consumedOnceIds.push(eventId);
	}
	if (!options?.dryRun) {
		for (const id of consumedOnceIds) state.messageEdits.delete(id);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

export function getContextEditorSnapshot(): ContextEditorSnapshot {
	const messageEdits: Record<string, MessageEdit> = {};
	for (const [id, edit] of state.messageEdits) messageEdits[id] = { ...edit };
	const snapshot: ContextEditorSnapshot = { loaded: state.loaded, messageEdits };
	if (state.systemPromptOverride) snapshot.systemPromptOverride = { ...state.systemPromptOverride };
	if (state.restoreBaseSystemPrompt !== undefined) snapshot.restoreBaseSystemPrompt = state.restoreBaseSystemPrompt;
	if (state.baseBeforePersistent !== undefined) snapshot.baseBeforePersistent = state.baseBeforePersistent;
	return snapshot;
}

/** 测试辅助：重置全部状态。 */
export function resetContextEditorStateForTest(): void {
	state.loaded = false;
	state.systemPromptOverride = undefined;
	state.restoreBaseSystemPrompt = undefined;
	state.baseBeforePersistent = undefined;
	state.messageEdits.clear();
}
