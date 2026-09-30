/**
 * context-editor 内置扩展测试
 *
 * 覆盖：
 * 1. 系统提示词覆盖状态机（once 消费→还原、persistent 持续、清除恢复）
 * 2. 消息编辑应用（按源事件 id 定位、once 消费、delete、角色替换规则）
 * 3. message-view 序列化（sentToLlm 镜像发送层过滤、editable/deletable 规则）
 * 4. ExtensionRunner.emitContext 的 sourceEventIds 透传与链式修改
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentMessage } from "../src/core/agent/types.js";
import type { Extension } from "../src/core/extensions/types.js";
import type { ExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	applyMessageEditsToContext,
	clearAllOverrides,
	clearSystemPromptOverride,
	consumeSystemPromptForSend,
	getContextEditorSnapshot,
	planSystemPromptForSend,
	resetContextEditorStateForTest,
	setMessageEdit,
	setSystemPromptOverride,
	markContextEditorLoaded,
} from "../src/builtin-extensions/context-editor/state.js";
import { toContextMessageView } from "../src/builtin-extensions/context-editor/message-view.js";

const ORIGINAL = "original system prompt";
const EDITED = "edited system prompt";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}
function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 };
}
function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	} as unknown as AgentMessage;
}
function assistantWithToolCall(): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } },
			{ type: "text", text: "running" },
		],
		timestamp: 4,
	} as unknown as AgentMessage;
}

beforeEach(() => {
	resetContextEditorStateForTest();
});

// ---------------------------------------------------------------------------
// 系统提示词覆盖状态机
// ---------------------------------------------------------------------------

describe("system prompt override state machine", () => {
	it("once：下一次发送用编辑文本，再下一次自动还原", () => {
		setSystemPromptOverride(EDITED, "once");

		// 预演不动状态
		const planned = planSystemPromptForSend(ORIGINAL);
		expect(planned.result).toBe(EDITED);
		expect(planSystemPromptForSend(ORIGINAL).result).toBe(EDITED);

		// 第一次消费：返回编辑文本
		expect(consumeSystemPromptForSend(ORIGINAL).result).toBe(EDITED);
		// 第二次消费：还原为捕获的原文本
		expect(consumeSystemPromptForSend(EDITED).result).toBe(ORIGINAL);
		// 第三次：无覆盖，不变
		expect(consumeSystemPromptForSend(ORIGINAL).result).toBeUndefined();
	});

	it("once 期间设置 persistent：还原轮被持续覆盖直接取代", () => {
		setSystemPromptOverride(EDITED, "once");
		expect(consumeSystemPromptForSend(ORIGINAL).result).toBe(EDITED);
		// 还原待执行时切到 persistent
		setSystemPromptOverride(EDITED + "-p", "persistent");
		expect(consumeSystemPromptForSend(EDITED).result).toBe(EDITED + "-p");
		// persistent 持续生效
		expect(consumeSystemPromptForSend(EDITED + "-p").result).toBe(EDITED + "-p");
	});

	it("persistent：每次发送都生效直到清除", () => {
		setSystemPromptOverride(EDITED, "persistent");
		expect(consumeSystemPromptForSend(ORIGINAL).result).toBe(EDITED);
		expect(consumeSystemPromptForSend(EDITED).result).toBe(EDITED);
		expect(consumeSystemPromptForSend(EDITED).result).toBe(EDITED);

		clearSystemPromptOverride();
		expect(consumeSystemPromptForSend(EDITED).result).toBeUndefined();
	});

	it("快照反映当前覆盖状态", () => {
		expect(getContextEditorSnapshot().loaded).toBe(false);
		markContextEditorLoaded();
		expect(getContextEditorSnapshot().loaded).toBe(true);

		setSystemPromptOverride(EDITED, "once");
		const snap = getContextEditorSnapshot();
		expect(snap.systemPromptOverride).toEqual({ text: EDITED, scope: "once" });

		consumeSystemPromptForSend(ORIGINAL);
		const snap2 = getContextEditorSnapshot();
		expect(snap2.systemPromptOverride).toBeUndefined();
		expect(snap2.restoreBaseSystemPrompt).toBe(ORIGINAL);
	});
});

// ---------------------------------------------------------------------------
// 消息编辑应用
// ---------------------------------------------------------------------------

describe("applyMessageEditsToContext", () => {
	const base = [userMessage("hello"), assistantMessage("hi"), userMessage("go")];
	const ids = ["e1", "e2", "e3"];

	it("按源事件 id 编辑 user 文本", () => {
		setMessageEdit("e1", { action: "edit", text: "HELLO-EDITED", scope: "persistent" });
		const out = applyMessageEditsToContext(base, ids);
		expect((out[0] as { content: unknown }).content).toBe("HELLO-EDITED");
		// 其他消息不动
		expect(out).toHaveLength(3);
		expect((out[2] as { content: unknown }).content).toBe("go");
		// persistent 不消费
		expect(applyMessageEditsToContext(base, ids)[0]).toMatchObject({ content: "HELLO-EDITED" });
	});

	it("once 编辑在应用一次后被消费", () => {
		setMessageEdit("e2", { action: "edit", text: "once!", scope: "once" });
		const first = applyMessageEditsToContext(base, ids);
		expect((first[1] as { content: unknown[] }).content[0]).toMatchObject({ text: "once!" });
		const second = applyMessageEditsToContext(base, ids);
		expect((second[1] as { content: unknown[] }).content[0]).toMatchObject({ text: "hi" });
	});

	it("delete 移除消息；once delete 同样消费", () => {
		setMessageEdit("e1", { action: "delete", scope: "once" });
		const out = applyMessageEditsToContext(base, ids);
		expect(out).toHaveLength(2);
		expect((out[0] as { content: Array<{ text: string }> }).content[0].text).toBe("hi");
		// once delete 已消费：再次应用不删
		expect(applyMessageEditsToContext(base, ids)).toHaveLength(3);
	});

	it("无 eventId 的消息不受编辑影响", () => {
		setMessageEdit("e1", { action: "delete", scope: "once" });
		const out = applyMessageEditsToContext([userMessage("x"), userMessage("y")], [undefined, "e9"]);
		// e9 不存在编辑；x 无 id
		expect(out).toHaveLength(2);
	});

	it("assistant 编辑保留 toolCall 块、丢弃 thinking", () => {
		const msg = assistantWithToolCall();
		setMessageEdit("e1", { action: "edit", text: "new text", scope: "persistent" });
		const out = applyMessageEditsToContext([msg], ["e1"]);
		const content = (out[0] as { content: Array<{ type: string }> }).content;
		expect(content).toHaveLength(2);
		expect(content[0]).toMatchObject({ type: "text", text: "new text" });
		expect(content[1]).toMatchObject({ type: "toolCall", id: "tc1" });
	});

	it("toolResult 编辑替换 content 为单一文本块", () => {
		setMessageEdit("e1", { action: "edit", text: "clean output", scope: "persistent" });
		const out = applyMessageEditsToContext([toolResultMessage("noisy")], ["e1"]);
		const toolResult = out[0] as unknown as { content: Array<{ type: string; text?: string }>; toolCallId: string };
		expect(toolResult.content).toEqual([{ type: "text", text: "clean output" }]);
		expect(toolResult.toolCallId).toBe("tc1");
	});

	it("dryRun 不消费 once 编辑", () => {
		setMessageEdit("e1", { action: "edit", text: "once!", scope: "once" });
		applyMessageEditsToContext(base, ids, { dryRun: true });
		expect(getContextEditorSnapshot().messageEdits["e1"]).toBeDefined();
	});

	it("clearAllOverrides 清空全部状态", () => {
		setSystemPromptOverride(EDITED, "persistent");
		setMessageEdit("e1", { action: "delete", scope: "persistent" });
		clearAllOverrides();
		const snap = getContextEditorSnapshot();
		expect(snap.systemPromptOverride).toBeUndefined();
		expect(Object.keys(snap.messageEdits)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// message-view 序列化
// ---------------------------------------------------------------------------

describe("toContextMessageView", () => {
	it("user/assistant/toolResult 标记为发送且可编辑", () => {
		const u = toContextMessageView(userMessage("hi"), "e1");
		expect(u.sentToLlm).toBe(true);
		expect(u.editable).toBe(true);
		expect(u.deletable).toBe(true);

		const a = toContextMessageView(assistantMessage("yo"), "e2");
		expect(a.sentToLlm).toBe(true);
		expect(a.editable).toBe(true);
		expect(a.deletable).toBe(true);

		const t = toContextMessageView(toolResultMessage("out"), "e3");
		expect(t.sentToLlm).toBe(true);
		expect(t.editable).toBe(true);
		// 工具结果不可删除（保护 toolCall 配对）
		expect(t.deletable).toBe(false);
		expect(t.note).toContain("toolCall");
	});

	it("assistant 带 toolCall 时不可删除但仍可编辑", () => {
		const v = toContextMessageView(assistantWithToolCall(), "e1");
		expect(v.editable).toBe(true);
		expect(v.deletable).toBe(false);
		expect(v.meta?.toolCallNames).toEqual(["bash"]);
		expect(v.text).toContain("running");
	});

	it("非发送角色标记 sentToLlm=false 且不可编辑（镜像 ai-client 过滤）", () => {
		const compaction = toContextMessageView(
			{ role: "compactionSummary", summary: "S", tokensBefore: 100, timestamp: 1 } as AgentMessage,
			"e1",
		);
		expect(compaction.sentToLlm).toBe(false);
		expect(compaction.editable).toBe(false);
		expect(compaction.note).toContain("不会到达模型");

		const custom = toContextMessageView(
			{ role: "custom", customType: "x", content: "c", timestamp: 1 } as unknown as AgentMessage,
			"e2",
		);
		expect(custom.sentToLlm).toBe(false);
	});

	it("user 消息带图片块时文本提取正确", () => {
		const msg: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		const v = toContextMessageView(msg, "e1");
		expect(v.text).toBe("look");
		expect(v.meta?.hasImages).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ExtensionRunner.emitContext 接线（含 sourceEventIds 透传）
// ---------------------------------------------------------------------------

describe("ExtensionRunner.emitContext", () => {
	it("context 事件收到 sourceEventIds，返回值链式替换消息", async () => {
		let observedIds: (string | undefined)[] | undefined;
		const extension: Extension = {
			path: "context-editor-test",
			resolvedPath: "context-editor-test",
			sourceInfo: { path: "context-editor-test", source: "test", scope: "temporary", origin: "top-level" },
			handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
				[
					"context",
					[
						async (event: { messages: AgentMessage[]; sourceEventIds?: (string | undefined)[] }) => {
							observedIds = event.sourceEventIds;
							return {
								messages: event.messages.filter((_, i) => i !== 0),
							};
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const runner = new ExtensionRunner(
			[extension],
			createExtensionRuntime(),
			process.cwd(),
			// emitContext 只调用 createContext()（全部是惰性 getter），
			// 本用例不触碰 sessionManager，传占位即可。
			undefined as unknown as ExtensionSessionManager,
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);

		const messages = [userMessage("drop-me"), userMessage("keep-me")];
		const out = await runner.emitContext(messages, ["e1", "e2"]);

		expect(observedIds).toEqual(["e1", "e2"]);
		expect(out).toHaveLength(1);
		expect((out[0] as { content: unknown }).content).toBe("keep-me");
		// 原数组不被修改（structuredClone）
		expect(messages).toHaveLength(2);
	});
});
