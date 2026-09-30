/**
 * proactive-assistant 类型定义。
 *
 * 建议是"当下"的产物：由 analyzer 从事件流信号即时推导，经 store 管理
 * 生命周期（active → dismissed/applied/expired），随 sidecar 生命周期存续。
 * 协议形态（RpcAssistant*）见 packages/protocol；这里是 agent 侧真身。
 */

/** 建议类别。 */
export type SuggestionKind =
	/** 阻塞提示：主模型疑似卡住，给出脱困动作。 */
	| "stuck_hint"
	/** 知识沉淀提议：本轮做得不错，询问是否沉淀为长期记忆。 */
	| "knowledge_offer"
	/** 上下文提示：上下文压力/截断等。 */
	| "context_hint";

/** 建议上可执行的动作。 */
export type SuggestionAction =
	| { kind: "compact" }
	| { kind: "steer"; text: string }
	| { kind: "continue" }
	| { kind: "save_knowledge" }
	| { kind: "dismiss" };

/** 一条主动建议。 */
export interface AssistantSuggestion {
	id: string;
	kind: SuggestionKind;
	severity: "info" | "warning";
	/** 短标题（一行）。 */
	title: string;
	/** 建议正文（说明为什么给这条建议 + 下一步）。 */
	body: string;
	/** 可执行动作（GUI 按钮顺序即数组顺序）。 */
	actions: SuggestionAction[];
	createdAt: number;
	/** 产生建议时的会话 id（展示/诊断用）。 */
	sessionId: string;
	/** 规则 id（如 "S1"），用于冷却与诊断。 */
	ruleId: string;
}

/** analyzer 结算出的一轮结论（内部传递，进 store 前的形态）。 */
export interface AnalyzerVerdict {
	suggestion?: Omit<AssistantSuggestion, "id" | "createdAt" | "sessionId">;
	/** 结算后允许向 GUI 广播。 */
	broadcastable: boolean;
}

/** 一轮 agent loop 内累积的信号快照（诊断/测试用）。 */
export interface TurnSignals {
	/** 本轮工具执行总次数。 */
	toolCalls: number;
	/** 本轮工具失败次数。 */
	toolFailures: number;
	/** 当前连续失败计数（成功即清零）。 */
	consecutiveFailures: number;
	/** 同一命令重复失败的最高次数。 */
	maxRepeatedIdenticalFailure: number;
	/** assistant stopReason（最后一次）。 */
	lastStopReason?: string;
	/** agent loop 完成原因（agent_end 载荷）。 */
	turnOutcome?: "stop" | "length" | "aborted" | "error";
}
