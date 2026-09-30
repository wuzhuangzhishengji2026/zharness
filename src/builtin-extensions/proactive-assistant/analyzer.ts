/**
 * proactive-assistant 分析器 —— 确定性规则引擎。
 *
 * 在一轮 agent loop 内从扩展事件累积信号，agent_end 时结算出 0..1 条建议。
 * 不调用 LLM：所有结论由事件流本身支撑（见 DESIGN.md 的信号表）。
 *
 * 用法（由 index.ts 的扩展 hooks 驱动）：
 *   analyzer.beginTurn()                    // before_agent_start
 *   analyzer.recordToolEnd(name,isError,key) // tool_execution_end
 *   analyzer.recordStopReason(reason)        // message_end(assistant)
 *   analyzer.settle(outcome, ctxStats)       // agent_end → verdict
 */

import type { AnalyzerVerdict, TurnSignals } from "./types.js";

// ---------------------------------------------------------------------------
// 阈值（集中在这里，测试与调参只看这一处）
// ---------------------------------------------------------------------------

/** S1：本轮连续工具失败达到该次数 → 阻塞提示。 */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** S2：同一命令/目标连续相同失败达到该次数 → 换思路提示。 */
const REPEATED_IDENTICAL_FAILURE_THRESHOLD = 2;
/** S4：上下文使用率（%）达到该值 → 建议压缩。 */
const CONTEXT_USAGE_THRESHOLD = 85;
/** K1：顺利完成的一轮至少要有这么多工具调用才算「做了实事」。 */
const SUCCESS_TOOL_CALLS_MIN = 5;
/** K1：会话内至少经历多少个用户轮后才发起沉淀提议。 */
const KNOWLEDGE_USER_TURNS_MIN = 2;

/** 按 ruleId 的优先顺序（一轮只出最高优先级一条建议）。 */
const RULE_PRIORITY = ["S5", "S1", "S2", "S3", "S4", "K1"] as const;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 结算时需要的会话级上下文（由 index.ts 提供）。 */
export interface SettleContext {
	/** agent loop 完成原因（AGENT_TURN_COMPLETED 载荷）。 */
	outcome: "stop" | "length" | "aborted" | "error";
	/** 上下文使用率（百分比，null=未知）。 */
	contextPercent: number | null;
	/** 会话内已发生的用户轮数（含当前这轮）。 */
	userTurns: number;
	/** 本会话是否已提示过知识沉淀。 */
	knowledgeOffered: boolean;
}

/**
 * @internal 导出仅供测试/诊断；运行时请走下面的记录/结算函数。
 */
export const signals: TurnSignals = resetSignals();

function resetSignals(): TurnSignals {
	// 注意把可选字段显式置 undefined：Object.assign 只覆盖源对象里存在的键，
	// 漏掉会让 lastStopReason 跨轮/跨测试残留，误触发 S3/S5。
	return {
		toolCalls: 0,
		toolFailures: 0,
		consecutiveFailures: 0,
		maxRepeatedIdenticalFailure: 0,
		lastStopReason: undefined,
		turnOutcome: undefined,
	};
}

/** 最近一次失败的工具指纹（工具名+目标）→ 连续出现次数。 */
const identicalFailures = new Map<string, number>();

/** 测试钩子：清空全部信号。 */
export function resetAnalyzerForTest(): void {
	Object.assign(signals, resetSignals());
	identicalFailures.clear();
}

// ---------------------------------------------------------------------------
// 记录面（hooks 调用）
// ---------------------------------------------------------------------------

/** 新一轮用户消息开始：重置轮内信号。 */
export function beginTurn(): void {
	Object.assign(signals, resetSignals());
	identicalFailures.clear();
}

/**
 * 记录一次工具执行结束。
 * @param key 工具指纹（工具名 + 目标参数摘要），用于识别「同一目标反复失败」。
 */
export function recordToolEnd(toolName: string, isError: boolean, key?: string): void {
	signals.toolCalls += 1;
	if (!isError) {
		signals.consecutiveFailures = 0;
		identicalFailures.clear();
		return;
	}
	signals.toolFailures += 1;
	signals.consecutiveFailures += 1;
	const fingerprint = `${toolName}:${key ?? ""}`;
	const count = (identicalFailures.get(fingerprint) ?? 0) + 1;
	identicalFailures.set(fingerprint, count);
	signals.maxRepeatedIdenticalFailure = Math.max(signals.maxRepeatedIdenticalFailure, count);
}

/** 记录 assistant 消息的 stopReason（消息级截断/错误早于 agent_end 出现）。 */
export function recordStopReason(reason: string | undefined): void {
	if (reason) signals.lastStopReason = reason;
}

/**
 * 推导本轮 agent loop 的完成原因。扩展的 agent_end 事件不携带
 * AGENT_TURN_COMPLETED 的 reason 载荷，用本轮最后一次 assistant 消息的
 * stopReason 等价推导；无消息（如纯错误轮）视为 stop 交给其余信号判定。
 */
export function currentOutcome(): "stop" | "length" | "aborted" | "error" {
	switch (signals.lastStopReason) {
		case "length":
		case "aborted":
		case "error":
			return signals.lastStopReason;
		default:
			return "stop";
	}
}

// ---------------------------------------------------------------------------
// 结算面（agent_end 调用）
// ---------------------------------------------------------------------------

/**
 * 结算本轮信号，产出建议。阻塞类规则按 RULE_PRIORITY 取最高一条；
 * 若无阻塞信号且本轮「做得好」，产出知识沉淀提议。
 */
export function settle(context: SettleContext): AnalyzerVerdict {
	const candidates: Array<AnalyzerVerdict["suggestion"] & { ruleId: string }> = [];

	// ---- 阻塞类 ------------------------------------------------------------
	if (signals.lastStopReason === "error") {
		candidates.push({
			kind: "stuck_hint",
			severity: "warning",
			ruleId: "S5",
			title: "模型这一轮以错误结束",
			body:
				"最后一次模型输出以 error 结束。可以让它先复盘报错原因再继续，" +
				"或检查模型/网络配置后重试。",
			actions: [
				{ kind: "steer", text: "刚才的回复以错误结束。请先简述报错原因，然后换一种方式继续完成原任务。" },
				{ kind: "dismiss" },
			],
		});
	}

	if (signals.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
		candidates.push({
			kind: "stuck_hint",
			severity: "warning",
			ruleId: "S1",
			title: `连续 ${signals.consecutiveFailures} 次工具执行失败`,
			body:
				"主模型似乎卡在了一连串失败的工具调用上。让它停下来复盘已尝试的路径与失败原因，" +
				"通常比继续重试更快脱困。",
			actions: [
				{ kind: "steer", text: "先暂停重试。请总结目前尝试过哪些方法、各自为什么失败，然后提出一条不同的实现路径再继续。" },
				{ kind: "dismiss" },
			],
		});
	}

	if (signals.maxRepeatedIdenticalFailure >= REPEATED_IDENTICAL_FAILURE_THRESHOLD) {
		candidates.push({
			kind: "stuck_hint",
			severity: "warning",
			ruleId: "S2",
			title: "同一操作在反复失败",
			body:
				"同一个工具调用以相同方式失败了多次。换一种达成目标的方式（改命令、换工具、或先核对环境）会比继续重复更有效。",
			actions: [
				{ kind: "steer", text: "同一个操作已经连续失败多次。请换一种不同的方式达成该目标，而不是重复同样的调用。" },
				{ kind: "dismiss" },
			],
		});
	}

	if (signals.lastStopReason === "length" || context.outcome === "length") {
		candidates.push({
			kind: "stuck_hint",
			severity: "info",
			ruleId: "S3",
			title: "回复因长度上限被截断",
			body: "这一轮输出到达了模型的最大 token 限制，内容不完整。发送「继续」让它接着写完。",
			actions: [
				{ kind: "continue" },
				{ kind: "dismiss" },
			],
		});
	}

	if (context.contextPercent !== null && context.contextPercent >= CONTEXT_USAGE_THRESHOLD) {
		candidates.push({
			kind: "context_hint",
			severity: "warning",
			ruleId: "S4",
			title: `上下文已使用 ${Math.round(context.contextPercent)}%`,
			body: "上下文窗口接近上限，较早的对话细节可能开始被截断。建议现在压缩上下文，避免长任务中途丢信息。",
			actions: [
				{ kind: "compact" },
				{ kind: "dismiss" },
			],
		});
	}

	// 阻塞类取最高优先级一条；无阻塞信号时才考虑沉淀提议。
	if (candidates.length > 0) {
		candidates.sort((a, b) => RULE_PRIORITY.indexOf(a.ruleId as (typeof RULE_PRIORITY)[number]) - RULE_PRIORITY.indexOf(b.ruleId as (typeof RULE_PRIORITY)[number]));
		return { suggestion: candidates[0], broadcastable: true };
	}

	const successful =
		context.outcome === "stop" &&
		signals.toolCalls >= SUCCESS_TOOL_CALLS_MIN &&
		signals.toolFailures === 0 &&
		context.userTurns >= KNOWLEDGE_USER_TURNS_MIN;

	if (successful && !context.knowledgeOffered) {
		return {
			suggestion: {
				kind: "knowledge_offer",
				severity: "info",
				ruleId: "K1",
				title: "这一轮完成得很顺利",
				body:
					`本轮 ${signals.toolCalls} 次工具调用全部成功、无失败重试。` +
					"要不要把这次的做法沉淀为长期知识？下次遇到类似任务可以直接复用。",
				actions: [
					{ kind: "save_knowledge" },
					{ kind: "dismiss" },
				],
			},
			broadcastable: true,
		};
	}

	return { broadcastable: false };
}
