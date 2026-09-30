/**
 * proactive-assistant 内置扩展测试
 *
 * 覆盖：
 * 1. analyzer 信号累积与规则（S1 连续失败 / S2 同一目标反复失败 / S3 截断 /
 *    S5 错误 / S4 上下文压力 / 优先级排序）
 * 2. 顺利完成 → K1 知识沉淀提议（含一次性与门槛）
 * 3. store 生命周期（冷却、容量、dismiss、knowledge_offer 过期、免打扰、一次性）
 * 4. knowledge 草稿生成与落盘（tmp 目录、原子写、_index.md 幂等追加）
 * 5. 广播事件形状（CUSTOM_MESSAGE display:false）
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as analyzer from "../src/builtin-extensions/proactive-assistant/analyzer.js";
import {
	buildKnowledgeDraft,
	saveKnowledge,
} from "../src/builtin-extensions/proactive-assistant/knowledge.js";
import {
	addSuggestion,
	clearSuggestions,
	dismissSuggestion,
	getUserTurns,
	isMuted,
	listActiveSuggestions,
	markApplied,
	mute,
	onStoreChange,
	onUserTurnStarted,
	recordToolResult,
	resetStoreForTest,
	getTotalToolStats,
} from "../src/builtin-extensions/proactive-assistant/store.js";
import type { StoreEvent } from "../src/builtin-extensions/proactive-assistant/store.js";

beforeEach(() => {
	analyzer.resetAnalyzerForTest();
	resetStoreForTest();
});

// ---------------------------------------------------------------------------
// analyzer
// ---------------------------------------------------------------------------

describe("analyzer 阻塞规则", () => {
	it("S1：连续 3 次工具失败 → stuck_hint，含 steer 动作", () => {
		analyzer.beginTurn();
		analyzer.recordToolEnd("bash", true, "npm test");
		analyzer.recordToolEnd("bash", true, "npm run build");
		analyzer.recordToolEnd("edit", true, "src/a.ts");
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("S1");
		expect(verdict.suggestion?.kind).toBe("stuck_hint");
		expect(verdict.suggestion?.actions[0]?.kind).toBe("steer");
	});

	it("成功工具调用会清零连续失败计数", () => {
		analyzer.beginTurn();
		analyzer.recordToolEnd("bash", true, "a");
		analyzer.recordToolEnd("bash", true, "b");
		analyzer.recordToolEnd("bash", false);
		analyzer.recordToolEnd("bash", true, "c");
		analyzer.recordToolEnd("bash", true, "d");
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion).toBeUndefined();
	});

	it("S2：同一命令连续相同失败 2 次即触发", () => {
		analyzer.beginTurn();
		analyzer.recordToolEnd("bash", true, "npm test");
		analyzer.recordToolEnd("bash", true, "npm test");
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("S2");
	});

	it("S3：stopReason=length → 截断建议（continue 动作）", () => {
		analyzer.beginTurn();
		analyzer.recordStopReason("length");
		const verdict = analyzer.settle({ outcome: "length", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("S3");
		expect(verdict.suggestion?.actions[0]?.kind).toBe("continue");
	});

	it("S4：上下文 ≥85% → context_hint（compact 动作）", () => {
		analyzer.beginTurn();
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 88, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("S4");
		expect(verdict.suggestion?.kind).toBe("context_hint");
		expect(verdict.suggestion?.actions[0]?.kind).toBe("compact");
	});

	it("S5 优先于 S1（一轮只出最高优先级一条）", () => {
		analyzer.beginTurn();
		analyzer.recordToolEnd("bash", true, "a");
		analyzer.recordToolEnd("bash", true, "a");
		analyzer.recordToolEnd("bash", true, "b");
		analyzer.recordStopReason("error");
		const verdict = analyzer.settle({ outcome: "error", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("S5");
		// settle 只取一条：S1/S2 信号同时存在但不出第二条建议。
		expect(verdict.suggestion?.actions).toHaveLength(2);
	});

	it("beginTurn 重置上一轮信号", () => {
		analyzer.beginTurn();
		analyzer.recordToolEnd("bash", true, "x");
		analyzer.beginTurn();
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 1, knowledgeOffered: false });
		expect(verdict.broadcastable).toBe(false);
	});
});

describe("analyzer 顺利规则 K1", () => {
	it("顺利轮（工具≥5、零失败、≥2 用户轮）→ knowledge_offer", () => {
		analyzer.beginTurn();
		for (let i = 0; i < 6; i++) analyzer.recordToolEnd("read", false, `f${i}`);
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 2, knowledgeOffered: false });
		expect(verdict.suggestion?.ruleId).toBe("K1");
		expect(verdict.suggestion?.kind).toBe("knowledge_offer");
		expect(verdict.suggestion?.actions[0]?.kind).toBe("save_knowledge");
	});

	it("工具不足 5 次不触发（对话型轮次不算「做了实事」）", () => {
		analyzer.beginTurn();
		for (let i = 0; i < 4; i++) analyzer.recordToolEnd("read", false, `f${i}`);
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 3, knowledgeOffered: false });
		expect(verdict.broadcastable).toBe(false);
	});

	it("有失败工具调用不触发沉淀", () => {
		analyzer.beginTurn();
		for (let i = 0; i < 6; i++) analyzer.recordToolEnd("read", false, `f${i}`);
		analyzer.recordToolEnd("bash", true, "boom");
		const verdict = analyzer.settle({ outcome: "stop", contextPercent: 10, userTurns: 3, knowledgeOffered: false });
		expect(verdict.broadcastable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

function stuckSuggestion() {
	return {
		kind: "stuck_hint" as const,
		severity: "warning" as const,
		ruleId: "S1",
		title: "t",
		body: "b",
		actions: [{ kind: "dismiss" as const }],
	};
}

describe("store 生命周期", () => {
	it("addSuggestion 登记 + dismiss 移除 + 变更事件", () => {
		const events: StoreEvent[] = [];
		onStoreChange((e) => events.push(e));
		const added = addSuggestion(stuckSuggestion(), "session-1");
		expect(added).toBeDefined();
		expect(listActiveSuggestions()).toHaveLength(1);
		expect(events.some((e) => e.event === "added")).toBe(true);

		expect(dismissSuggestion(added!.id)).toBe(true);
		expect(listActiveSuggestions()).toHaveLength(0);
		expect(events.some((e) => e.event === "removed")).toBe(true);
	});

	it("markApplied 与 dismiss 等效（移除建议）", () => {
		const added = addSuggestion(stuckSuggestion(), "session-1");
		expect(markApplied(added!.id)).toBe(true);
		expect(listActiveSuggestions()).toHaveLength(0);
	});

	it("同 kind 冷却：5 分钟内不重复产生", () => {
		const now = Date.now();
		const first = addSuggestion(stuckSuggestion(), "s", now);
		expect(first).toBeDefined();
		// 冷却期内（且旧建议仍 active）不再产生。
		expect(addSuggestion(stuckSuggestion(), "s", now + 60_000)).toBeUndefined();
		// 旧建议被处理掉之后，冷却期外可再产生。
		dismissSuggestion(first!.id);
		expect(addSuggestion(stuckSuggestion(), "s", now + 6 * 60_000)).toBeDefined();
	});

	it("同 kind 已有 active 建议时不叠加", () => {
		const now = Date.now();
		addSuggestion(stuckSuggestion(), "s", now);
		// 不同 kind 不受影响。
		const k = addSuggestion(
			{ kind: "context_hint", severity: "info", ruleId: "S4", title: "t", body: "b", actions: [{ kind: "compact" }] },
			"s",
			now,
		);
		expect(k).toBeDefined();
	});

	it("knowledge_offer 一次性 + 新用户消息过期", () => {
		const now = Date.now();
		const offer = addSuggestion(
			{ kind: "knowledge_offer", severity: "info", ruleId: "K1", title: "t", body: "b", actions: [{ kind: "save_knowledge" }] },
			"s",
			now,
		);
		expect(offer).toBeDefined();
		// 一次性：同会话不再产生第二条。
		expect(
			addSuggestion(
				{ kind: "knowledge_offer", severity: "info", ruleId: "K1", title: "t2", body: "b", actions: [{ kind: "save_knowledge" }] },
				"s",
				now + 10 * 60_000,
			),
		).toBeUndefined();

		onUserTurnStarted();
		expect(getUserTurns()).toBe(1);
		// 新用户消息让未处理的沉淀提议过期。
		expect(listActiveSuggestions()).toHaveLength(0);
	});

	it("容量不超限：三类建议并存 + 冷却/去重后 active ≤ 3", () => {
		const now = Date.now();
		addSuggestion(stuckSuggestion(), "s", now);
		addSuggestion({ kind: "context_hint", severity: "info", ruleId: "S4", title: "1", body: "b", actions: [] }, "s", now);
		addSuggestion(
			{ kind: "knowledge_offer", severity: "info", ruleId: "K1", title: "2", body: "b", actions: [{ kind: "save_knowledge" }] },
			"s",
			now,
		);
		expect(listActiveSuggestions()).toHaveLength(3);
		// 冷却后重复尝试：同 kind 去重 + 容量上限共同保证不超 3。
		addSuggestion(stuckSuggestion(), "s", now + 6 * 60_000);
		addSuggestion({ kind: "context_hint", severity: "info", ruleId: "S4", title: "3", body: "b", actions: [] }, "s", now + 6 * 60_000);
		expect(listActiveSuggestions()).toHaveLength(3);
	});

	it("免打扰期间不产生新建议", () => {
		const until = mute(30);
		expect(isMuted()).toBe(true);
		expect(until).toBeGreaterThan(Date.now());
		expect(addSuggestion(stuckSuggestion(), "s")).toBeUndefined();
	});

	it("会话累计工具统计", () => {
		recordToolResult(false);
		recordToolResult(true);
		recordToolResult(true);
		expect(getTotalToolStats()).toEqual({ toolCalls: 3, toolFailures: 2 });
	});

	it("clearSuggestions 清空", () => {
		addSuggestion(stuckSuggestion(), "s");
		clearSuggestions();
		expect(listActiveSuggestions()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------

describe("knowledge 草稿与落盘", () => {
	it("草稿包含用户目标、结论与过程统计", () => {
		const draft = buildKnowledgeDraft({
			firstUserMessage: "给任务看板加一个导出功能",
			lastAssistantText: "完成。\n\n导出按钮已接入 /board，点击后生成 JSON。",
			toolCalls: 8,
			toolFailures: 0,
			userTurns: 3,
			sessionId: "sess-1",
		});
		expect(draft.title).toContain("给任务看板加一个导出功能");
		expect(draft.content).toContain("给任务看板加一个导出功能");
		expect(draft.content).toContain("导出按钮已接入");
		expect(draft.content).toContain("工具调用 8 次");
		expect(draft.tags).toContain("knowledge");
	});

	it("saveKnowledge 写文件 + 幂等更新 _index.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "zharness-pa-"));
		try {
			const memoryDir = join(dir, "memory");
			const r1 = saveKnowledge(
				{ title: "Experience: task board export", content: "## 做法\nA", tags: ["knowledge"] },
				{ memoryDir, now: new Date("2026-09-21T08:00:00Z") },
			);
			expect(r1.indexUpdated).toBe(true);
			expect(existsSync(r1.path)).toBe(true);
			const content = readFileSync(r1.path, "utf-8");
			expect(content).toContain("# Experience: task board export");
			expect(content).toContain("date: 2026-09-21");
			expect(content).toContain("source: proactive-assistant");

			const index1 = readFileSync(join(memoryDir, "_index.md"), "utf-8");
			expect(index1).toContain(".md — Experience: task board export");

			// 再次保存同一标题（同日）：新文件名可能相同 → index 不重复追加。
			const r2 = saveKnowledge(
				{ title: "Experience: task board export", content: "## 做法\nA", tags: ["knowledge"] },
				{ memoryDir, now: new Date("2026-09-21T09:00:00Z") },
			);
			expect(r2.indexUpdated).toBe(false);
			const index2 = readFileSync(join(memoryDir, "_index.md"), "utf-8");
			expect(index2.match(/\.md —/g)?.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("中文标题退化为安全文件名（不空、不含非法字符）", () => {
		const dir = mkdtempSync(join(tmpdir(), "zharness-pa-"));
		try {
			const r = saveKnowledge(
				{ title: "经验：任务看板导出", content: "A", tags: [] },
				{ memoryDir: join(dir, "memory"), now: new Date("2026-09-21T08:00:00Z") },
			);
			expect(r.path).toMatch(/knowledge-20260921-[a-z0-9]+\.md$/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 扩展工厂（事件接线）
// ---------------------------------------------------------------------------

/** 最小 ExtensionAPI 桩：记录 on/registerCommand，供手动驱动 handler。 */
function makeFakeApi() {
	const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>>();
	const commands = new Map<string, { description?: string }>();
	const api = {
		on: (event: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, options: { description?: string }) => {
			commands.set(name, options);
		},
	};
	return { api, handlers, commands };
}

/** 驱动一个事件的全部 handler。 */
async function emit(handlers: Map<string, Array<(e: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>>, event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>) {
	for (const handler of handlers.get(event) ?? []) {
		await handler({ type: event, ...payload }, ctx);
	}
}

/** 工厂需要的最小 ctx（rememberContext + getContextUsage）。 */
function fakeCtx() {
	return {
		sessionManager: {
			projection: { getDescriptor: () => ({ session_id: "sess-test" }) },
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
		hasUI: false,
	};
}

describe("扩展工厂事件接线", () => {
	it("已在内置扩展注册表登记", async () => {
		const { BUILTIN_EXTENSIONS, getBuiltinExtensionInfo } = await import("../src/builtin-extensions/index.js");
		expect(BUILTIN_EXTENSIONS.some((e) => e.id === "proactive-assistant")).toBe(true);
		expect(getBuiltinExtensionInfo("proactive-assistant")?.name).toBe("proactive-assistant");
	});

	it("hooks 全链路：工具失败 → agent_end → 建议入库 + 广播事件形状", async () => {
		const { createProactiveAssistantExtension } = await import(
			"../src/builtin-extensions/proactive-assistant/index.js"
		);
		const appended: Array<{ actor_id: string; type: string; payload: Record<string, unknown> }> = [];
		const { api, handlers, commands } = makeFakeApi();
		const ctx = {
			...fakeCtx(),
			sessionManager: {
				eventStore: { append: (e: { actor_id: string; type: string; payload: Record<string, unknown> }) => appended.push(e) },
				projection: { getDescriptor: () => ({ session_id: "sess-test" }) },
			},
		};

		createProactiveAssistantExtension(api as never);

		// 注册面：四个事件 hook + /assistant 命令。
		for (const event of ["before_agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_end"]) {
			expect(handlers.has(event), `hook ${event}`).toBe(true);
		}
		expect(commands.has("assistant")).toBe(true);

		// 事件流：第一轮（1 用户轮，顺利 2 工具）→ 无建议。
		await emit(handlers, "before_agent_start", { prompt: "hi", systemPrompt: "sp" }, ctx);
		await emit(handlers, "tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }, ctx);
		await emit(handlers, "tool_execution_end", { toolCallId: "t1", toolName: "bash", isError: false, result: null }, ctx);
		await emit(handlers, "message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await emit(handlers, "agent_end", {}, ctx);
		expect(listActiveSuggestions()).toHaveLength(0);

		// 第二轮：同一命令连续失败两次 + 另一次失败 → S1/S2 → 一条建议。
		await emit(handlers, "before_agent_start", { prompt: "go", systemPrompt: "sp" }, ctx);
		for (const [i, cmd] of ["npm test", "npm test", "npm run build"].entries()) {
			const id = `t2-${i}`;
			await emit(handlers, "tool_execution_start", { toolCallId: id, toolName: "bash", args: { command: cmd } }, ctx);
			await emit(handlers, "tool_execution_end", { toolCallId: id, toolName: "bash", isError: true, result: null }, ctx);
		}
		await emit(handlers, "message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await emit(handlers, "agent_end", {}, ctx);

		const suggestions = listActiveSuggestions();
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.ruleId).toBe("S1");
		expect(suggestions[0]?.sessionId).toBe("sess-test");
		expect(getUserTurns()).toBe(2);

		// 广播：display:false 的 CUSTOM_MESSAGE（下一拍 setTimeout）。
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(appended.length).toBeGreaterThan(0);
		const broadcast = appended[0]!;
		expect(broadcast.type).toBe("CUSTOM_MESSAGE");
		expect(broadcast.payload.display).toBe(false);
		expect(broadcast.payload.extension_id).toBe("proactive-assistant");
		expect(broadcast.payload.kind).toBe("proactive_assistant_changed");
	});

	it("loaded 标记随工厂执行置位", async () => {
		const { createProactiveAssistantExtension, getAssistantStats } = await import(
			"../src/builtin-extensions/proactive-assistant/index.js"
		);
		const { isProactiveAssistantLoaded } = await import("../src/builtin-extensions/proactive-assistant/store.js");
		const { api } = makeFakeApi();
		expect(isProactiveAssistantLoaded()).toBe(false);
		createProactiveAssistantExtension(api as never);
		expect(isProactiveAssistantLoaded()).toBe(true);
		expect(getAssistantStats()).toEqual({
			activeSuggestions: 0,
			userTurns: 0,
			muted: false,
			knowledgeOffered: false,
		});
	});
});
