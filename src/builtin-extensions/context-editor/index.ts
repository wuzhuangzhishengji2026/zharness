/**
 * Built-in extension: context-editor —— 上下文编辑器。
 *
 * 用户在发送消息前查看「真正的上下文」（系统提示词 / 工具列表 / 从事件
 * 日志投影出的消息序列），并施加覆盖编辑：
 *
 * 1. `before_agent_start` —— 系统提示词覆盖（once：仅下一轮，之后自动
 *    还原；persistent：本会话后续每轮，直到清除）。每轮开始前重新应用，
 *    因此 once 的还原语义由状态机保证（见 state.ts）。
 * 2. `context` —— 消息编辑（按源事件 id 定位，只改发给 LLM 的投影，
 *    不动事件日志；once：仅下一次 LLM 请求；persistent：后续每次请求）。
 *
 * GUI 入口：Composer 的「上下文」按钮 → ContextEditorDialog，经
 * context_preview / context_apply / context_overrides_clear RPC 读写
 * state.ts 的同一份内存状态（协议见 packages/protocol）。
 *
 * Enable/disable state is persisted in `settings.json` under
 * `disabledBuiltinExtensions`（同 task-board 模式，重启 sidecar 生效）。
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.js";
import {
	applyMessageEditsToContext,
	consumeSystemPromptForSend,
	markContextEditorLoaded,
} from "./state.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const CONTEXT_EDITOR_EXTENSION_ID = "context-editor";

export const createContextEditorExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	markContextEditorLoaded();

	// 系统提示词覆盖：状态机见 state.ts（once 消费 → 下一轮还原）。
	zharness.on("before_agent_start", (event) => {
		const { result } = consumeSystemPromptForSend(event.systemPrompt);
		if (result !== undefined) {
			return { systemPrompt: result };
		}
		return undefined;
	});

	// 消息编辑：每次 LLM 调用前应用到投影消息（返回值经 reactor 的
	// transformContext 接线真正替换即将发送的消息）。
	zharness.on("context", (event) => {
		const messages = applyMessageEditsToContext(event.messages, event.sourceEventIds);
		return { messages };
	});
};
