/**
 * context-editor 上下文打分器测试
 *
 * 覆盖：
 * 1. 打分 prompt 构建（消息编号 / 截断 / 预算裁剪 / 草稿锚点）
 * 2. 打分结果解析（合法 JSON / fenced JSON / 前后噪声 / 越界与非法值 clamp）
 * 3. 上下文指纹（稳定性 / 对编辑与草稿敏感）
 * 4. 后台任务状态机（running 单飞 / done 缓存命中 / force 重跑 / cancel）
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { LLMClient, LLMResponse, ModelConfig } from "../src/core/runtime/llm-types.js";
import {
	buildScoringUserPrompt,
	cancelContextScore,
	computeContextFingerprint,
	getContextScoreStatus,
	parseScoreResponse,
	resetContextScoreForTest,
	selectMessagesForPrompt,
	startContextScore,
	type ContextScoreInput,
	type ScoreMessageInput,
} from "../src/builtin-extensions/context-editor/scorer.js";

function msg(index: number, overrides: Partial<ScoreMessageInput> = {}): ScoreMessageInput {
	return {
		eventId: `ev-${index}`,
		kind: "user",
		role: "user",
		text: `message ${index}: ${"x".repeat(50)}`,
		charCount: 50 + String(index).length + 10,
		sentToLlm: true,
		...overrides,
	};
}

function baseInput(overrides: Partial<ContextScoreInput> = {}): ContextScoreInput {
	return {
		sessionId: "s1",
		effectiveSystemPrompt: "You are a helpful agent.",
		toolNames: ["read", "bash"],
		messages: [msg(0), msg(1, { kind: "toolResult", role: "toolResult" }), msg(2)],
		draft: "继续修复登录 bug",
		...overrides,
	};
}

describe("buildScoringUserPrompt", () => {
	it("包含系统提示词、工具、逐条消息与草稿锚点", () => {
		const prompt = buildScoringUserPrompt(baseInput());
		expect(prompt).toContain("=== SYSTEM PROMPT (truncated) ===");
		expect(prompt).toContain("You are a helpful agent.");
		expect(prompt).toContain("=== TOOLS (2) ===");
		expect(prompt).toContain("read, bash");
		expect(prompt).toContain("--- #0 [user] ---");
		expect(prompt).toContain("--- #1 [toolResult] ---");
		expect(prompt).toContain("=== USER'S NEXT DRAFT (not yet in context) ===");
		expect(prompt).toContain("继续修复登录 bug");
	});

	it("无草稿时给出占位说明", () => {
		const prompt = buildScoringUserPrompt(baseInput({ draft: undefined }));
		expect(prompt).toContain("(no draft");
	});

	it("不发送给模型的消息带标注", () => {
		const input = baseInput({
			messages: [msg(0, { kind: "bashExecution", role: "bashExecution", sentToLlm: false })],
		});
		const prompt = buildScoringUserPrompt(input);
		expect(prompt).toContain("[not sent to LLM]");
	});

	it("超长消息被截断并标注原长", () => {
		const long = msg(0, { text: "y".repeat(5000), charCount: 5000 });
		const prompt = buildScoringUserPrompt(baseInput({ messages: [long] }));
		expect(prompt).not.toContain("y".repeat(1000));
		expect(prompt).toContain("截断");
	});
});

describe("selectMessagesForPrompt", () => {
	it("未超限原样保留、无省略标记", () => {
		const messages = Array.from({ length: 10 }, (_, i) => msg(i));
		const { selected, markers } = selectMessagesForPrompt(messages);
		expect(selected).toHaveLength(10);
		expect(markers).toHaveLength(0);
	});

	it("条数超限时保头尾、中段缺口生成省略标记", () => {
		const messages = Array.from({ length: 150 }, (_, i) => msg(i));
		const { selected, markers } = selectMessagesForPrompt(messages);
		expect(selected.length).toBeLessThanOrEqual(120);
		// 头 10 条保住（任务起点）。
		expect(selected[0]!.index).toBeLessThanOrEqual(10);
		// 尾部保住最新一条。
		expect(selected.at(-1)!.index).toBe(149);
		// 中段缺口有内联标记。
		expect(markers.length).toBeGreaterThanOrEqual(1);
		const middle = markers[0]!;
		expect(middle.count).toBe(150 - selected.length);
		expect(middle.beforeIndex).toBe(selected.find((s) => s.index >= 10)!.index);
	});

	it("字符超预算时从较旧一侧继续丢", () => {
		const messages = Array.from({ length: 80 }, (_, i) => msg(i, { charCount: 4000 }));
		const { selected, markers } = selectMessagesForPrompt(messages);
		expect(selected.length).toBeLessThan(80);
		// 保底 12 条。
		expect(selected.length).toBeGreaterThanOrEqual(12);
		expect(selected.at(-1)!.index).toBe(79);
		// 开头缺口生成标记。
		expect(markers[0]!.beforeIndex).toBe(selected[0]!.index);
	});

	it("省略标记进 prompt 转写", () => {
		const messages = Array.from({ length: 150 }, (_, i) => msg(i));
		const prompt = buildScoringUserPrompt(baseInput({ messages }));
		expect(prompt).toContain("messages omitted for budget");
	});
});

describe("parseScoreResponse", () => {
	const messages = [msg(0), msg(1), msg(2)];

	it("解析合法 JSON 并保留结构", () => {
		const result = parseScoreResponse(
			JSON.stringify({
				overall: 82,
				dimensions: [{ key: "relevance", score: 90, comment: "聚焦当前任务" }],
				summary: "总体健康。",
				messages: [{ index: 1, label: "low", reason: "重复的工具输出", suggestion: "delete" }],
			}),
			messages,
		);
		expect(result.overall).toBe(82);
		expect(result.dimensions[0]).toMatchObject({ key: "relevance", score: 90 });
		expect(result.summary).toBe("总体健康。");
		expect(result.messageAnnotations[0]).toMatchObject({
			eventId: "ev-1",
			index: 1,
			label: "low",
			suggestion: "delete",
		});
	});

	it("容忍 fenced JSON 与前后噪声", () => {
		const raw = 'Here you go:\n```json\n{"overall": 70, "dimensions": [], "summary": "ok", "messages": []}\n```\nDone.';
		const result = parseScoreResponse(raw, messages);
		expect(result.overall).toBe(70);
	});

	it("分数越界被 clamp，非法条目被丢弃", () => {
		const raw = JSON.stringify({
			overall: 150,
			dimensions: [
				{ key: "relevance", score: -20 },
				{ key: "bad", score: "not-a-number" },
				{ key: "coherence", score: "66" },
			],
			messages: [
				{ index: 99, label: "low" },
				{ index: 0, label: "bogus", suggestion: "explode" },
				{ index: 2, label: "high" },
			],
		});
		const result = parseScoreResponse(raw, messages);
		expect(result.overall).toBe(100);
		// -20 → 0；非法 score 丢弃；字符串数字可解析。
		expect(result.dimensions).toEqual([
			{ key: "relevance", score: 0, comment: undefined },
			{ key: "coherence", score: 66, comment: undefined },
		]);
		// 越界 index 丢弃；非法 label/suggestion 回退默认。
		expect(result.messageAnnotations).toHaveLength(2);
		expect(result.messageAnnotations[0]).toMatchObject({ index: 0, label: "medium" });
		expect(result.messageAnnotations[1]).toMatchObject({ index: 2, label: "high" });
	});

	it("非 JSON 输出抛错", () => {
		expect(() => parseScoreResponse("I cannot do that.", messages)).toThrow();
		expect(() => parseScoreResponse('{"dimensions": []}', messages)).toThrow();
	});
});

describe("computeContextFingerprint", () => {
	it("相同输入指纹稳定", () => {
		expect(computeContextFingerprint(baseInput())).toBe(computeContextFingerprint(baseInput()));
	});

	it("草稿 / 消息数 / 系统提示词长度变化都会改变指纹", () => {
		const base = computeContextFingerprint(baseInput());
		expect(computeContextFingerprint(baseInput({ draft: "换个任务" }))).not.toBe(base);
		expect(computeContextFingerprint(baseInput({ messages: [msg(0)] }))).not.toBe(base);
		expect(
			computeContextFingerprint(baseInput({ effectiveSystemPrompt: "x".repeat(999) })),
		).not.toBe(base);
	});
});

// ---------------------------------------------------------------------------
// 任务状态机（用假 LLMClient 驱动）
// ---------------------------------------------------------------------------

function fakeClient(result: string, seen: string[] = []): LLMClient {
	return {
		async complete(request) {
			seen.push(request.messages[0] ? JSON.stringify(request.messages[0].content).slice(0, 200) : "");
			const response: LLMResponse = {
				content: [{ type: "text", text: result }],
				provider: "test",
				model: "m1",
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
				stopReason: "stop",
			};
			return response;
		},
	};
}

const MODEL: ModelConfig = { provider: "test", model_id: "m1" };

const VALID = JSON.stringify({
	overall: 75,
	dimensions: [{ key: "relevance", score: 80, comment: "好" }],
	summary: "可以。",
	messages: [{ index: 0, label: "low", reason: "重复", suggestion: "trim" }],
});

beforeEach(() => {
	resetContextScoreForTest();
});

describe("startContextScore", () => {
	it("start 立即返回 running，随后完成并缓存", async () => {
		const snapshot = startContextScore({ llmClient: fakeClient(VALID), model: MODEL, input: baseInput() });
		expect(snapshot.status).toBe("running");
		await new Promise((r) => setTimeout(r, 20));
		const done = getContextScoreStatus();
		expect(done.status).toBe("done");
		expect(done.result?.overall).toBe(75);
		expect(done.result?.messageAnnotations[0]?.eventId).toBe("ev-0");
		expect(done.model).toBe("test/m1");
	});

	it("上下文未变时命中缓存，不重复调用", async () => {
		const seen: string[] = [];
		startContextScore({ llmClient: fakeClient(VALID, seen), model: MODEL, input: baseInput() });
		await new Promise((r) => setTimeout(r, 20));
		const again = startContextScore({ llmClient: fakeClient(VALID, seen), model: MODEL, input: baseInput() });
		expect(again.status).toBe("done");
		expect(again.result?.overall).toBe(75);
		expect(seen).toHaveLength(1);
	});

	it("force 强制重跑", async () => {
		const seen: string[] = [];
		startContextScore({ llmClient: fakeClient(VALID, seen), model: MODEL, input: baseInput() });
		await new Promise((r) => setTimeout(r, 20));
		startContextScore({ llmClient: fakeClient(VALID, seen), model: MODEL, input: baseInput(), force: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toHaveLength(2);
	});

	it("上下文变化后 stale 置位", async () => {
		startContextScore({ llmClient: fakeClient(VALID), model: MODEL, input: baseInput() });
		await new Promise((r) => setTimeout(r, 20));
		const sameFp = computeContextFingerprint(baseInput());
		expect(getContextScoreStatus(sameFp).stale).toBe(false);
		const changedFp = computeContextFingerprint(baseInput({ draft: "新任务" }));
		expect(getContextScoreStatus(changedFp).stale).toBe(true);
	});

	it("模型返回错误时进入 error", async () => {
		const client: LLMClient = {
			async complete() {
				return {
					content: [],
					provider: "test",
					model: "m1",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "error",
					errorMessage: "boom",
				};
			},
		};
		startContextScore({ llmClient: client, model: MODEL, input: baseInput() });
		await new Promise((r) => setTimeout(r, 20));
		const failed = getContextScoreStatus();
		expect(failed.status).toBe("error");
		expect(failed.error).toContain("boom");
	});

	it("cancel 中止进行中的任务", async () => {
		let release: (() => void) | undefined;
		const client: LLMClient = {
			complete: () =>
				new Promise<LLMResponse>((resolve) => {
					release = () =>
						resolve({
							content: [{ type: "text", text: VALID }],
							provider: "test",
							model: "m1",
							usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
							stopReason: "stop",
						});
				}),
		};
		startContextScore({ llmClient: client, model: MODEL, input: baseInput() });
		expect(getContextScoreStatus().status).toBe("running");
		cancelContextScore();
		release?.();
		await new Promise((r) => setTimeout(r, 20));
		// cancel 后即使假调用结束也不落结果。
		expect(getContextScoreStatus().status).not.toBe("running");
		expect(getContextScoreStatus().result).toBeUndefined();
	});
});
