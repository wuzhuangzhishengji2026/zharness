/**
 * context-editor 上下文打分器。
 *
 * 用一次独立的 LLM 调用评估「即将发送的上下文」的质量（相关性 / 冗余 /
 * 连贯 / 精简 / 可靠），并给出逐条消息的保留建议。设计要点：
 *
 * 1. 按需触发、后台执行 —— LLM 调用慢（用户已知实时性差），所以 RPC 的
 *    start 立即返回 running，前端轮询 status；结果按「上下文指纹」缓存在
 *    进程内，上下文没变就不重复花一次调用。
 * 2. 输入镜像 context_preview —— 同一份投影 + 覆盖预演（dryRun 不消费
 *    once 编辑），打分对象与「应用并发送”真正到达模型的内容一致。
 * 3. 体积有界 —— 每条消息截头去尾，总量超预算时丢弃中段旧消息，避免
 *    打分调用本身撑爆上下文窗口。
 * 4. 输出防御性解析 —— 模型返回 fenced JSON / 前后噪声都能兜住；分数
 *    一律 clamp 到 [0,100]。
 *
 * 纯函数（prompt 构建 / 解析 / 指纹）与 LLM 调用放同一模块，方便单测
 * 不起 sidecar 直接覆盖（见 test/context-score.test.ts）。
 */

import type { AgentMessage } from "../../core/agent/types.js";
import type { LLMClient, ModelConfig } from "../../core/runtime/llm-types.js";

// ---------------------------------------------------------------------------
// 输入形态（rpc-mode 从 RpcContextMessage 投影映射过来，结构兼容即可）
// ---------------------------------------------------------------------------

/** 打分用的一条消息（文本已含覆盖预演）。 */
export interface ScoreMessageInput {
	eventId?: string;
	kind: string;
	role: string;
	/** 展示文本（截断由本模块负责）。 */
	text: string;
	charCount: number;
	sentToLlm: boolean;
}

export interface ContextScoreInput {
	sessionId: string;
	/** 覆盖预演后的生效系统提示词。 */
	effectiveSystemPrompt: string;
	/** 工具名列表（描述不进打分输入，太长）。 */
	toolNames: string[];
	messages: ScoreMessageInput[];
	/** 待发送草稿（用户下一步意图，相关性评判的锚点）。 */
	draft?: string;
}

/** 打分结果（RPC 快照形态）。 */
export interface ContextScoreResult {
	overall: number;
	dimensions: Array<{ key: string; score: number; comment?: string }>;
	summary: string;
	messageAnnotations: Array<{
		eventId?: string;
		index: number;
		label: "high" | "medium" | "low";
		reason?: string;
		suggestion?: "keep" | "trim" | "edit" | "delete";
	}>;
	generatedAt: number;
}

export type ContextScoreJobStatus = "idle" | "running" | "done" | "error";

export interface ContextScoreJobSnapshot {
	status: ContextScoreJobStatus;
	/** 打分时的上下文指纹（调用方比对当前指纹判断是否过期）。 */
	fingerprint?: string;
	/** 缓存结果是否已过期（有结果且调用方传入当前指纹时附带）。 */
	stale?: boolean;
	startedAt?: number;
	finishedAt?: number;
	model?: string;
	error?: string;
	result?: ContextScoreResult;
}

// ---------------------------------------------------------------------------
// 体积预算
// ---------------------------------------------------------------------------

/** 单条消息进入打分输入的字符上限（截头保尾：结论通常在尾部）。 */
const PER_MESSAGE_CHAR_CAP = 800;
/** 打分输入的总字符预算（超限丢弃中段，保留头尾）。 */
const TOTAL_CHAR_BUDGET = 60_000;
/** 进入打分输入的最大消息条数。 */
const MAX_MESSAGES = 120;
/** 结果里逐条标注的条数上限。 */
const MAX_ANNOTATIONS = 20;
/** 单次打分调用的超时。 */
const SCORE_TIMEOUT_MS = 180_000;

const DIMENSION_KEYS = ["relevance", "redundancy", "coherence", "efficiency", "reliability"] as const;

const SCORING_SYSTEM_PROMPT = `You are a context quality auditor for an AI coding agent. You will receive the exact context (system prompt, tool list, message history) that is about to be sent to the model, plus the user's next draft message. Your job is to judge how well this context will serve that next request.

You never answer the user's request itself. You only audit the context quality.

Score five dimensions, each 0-100 (higher is better):
- relevance: how much of the context is actually useful for the next request vs off-task drift
- redundancy: freedom from duplicated tool outputs, repeated information and noise (100 = no redundancy)
- coherence: structural integrity — tool call/result pairing, logical order, no orphaned references
- efficiency: token budget well spent — no oversized tool results or verbose boilerplate that should have been trimmed
- reliability: content is current and consistent — no stale/outdated facts, resolved-error leftovers, or contradictions

overall is your single 0-100 judgement of the context as a whole.

Also annotate individual messages that deserve attention (not all of them): label each as high / medium / low value for the next request, with a short reason and a suggestion (keep / trim / edit / delete).

Respond with ONLY a JSON object in this exact shape, no prose before or after:
{
  "overall": <0-100 integer>,
  "dimensions": [
    { "key": "relevance", "score": <0-100>, "comment": "<one short sentence>" },
    { "key": "redundancy", "score": <0-100>, "comment": "<one short sentence>" },
    { "key": "coherence", "score": <0-100>, "comment": "<one short sentence>" },
    { "key": "efficiency", "score": <0-100>, "comment": "<one short sentence>" },
    { "key": "reliability", "score": <0-100>, "comment": "<one short sentence>" }
  ],
  "summary": "<2-4 sentences: biggest quality risks and the single most impactful fix>",
  "messages": [
    { "index": <message index from the transcript>, "label": "high" | "medium" | "low", "reason": "<short>", "suggestion": "keep" | "trim" | "edit" | "delete" }
  ]
}

Write comment / reason / summary in 简体中文. Omit "messages" entries for unremarkable messages; keep at most ${MAX_ANNOTATIONS}.`;

// ---------------------------------------------------------------------------
// 纯函数：输入裁剪 / prompt 构建 / 解析 / 指纹
// ---------------------------------------------------------------------------

function clipMessage(text: string, charCount: number): string {
	if (text.length <= PER_MESSAGE_CHAR_CAP) return text;
	const head = text.slice(0, Math.floor(PER_MESSAGE_CHAR_CAP * 0.7));
	const tail = text.slice(-Math.floor(PER_MESSAGE_CHAR_CAP * 0.2));
	return `${head}\n…[截断，原长 ${charCount.toLocaleString()} 字符]…\n${tail}`;
}

/** 转写里的省略标记：插在 beforeIndex 对应条目之前。 */
export interface OmittedMarker {
	beforeIndex: number;
	count: number;
}

/**
 * 选择进入打分输入的消息：条数超限时保留最旧 10 条（任务起点）+ 最新
 * 一段；字符超预算时从较旧一侧继续丢。返回保留集与内联省略标记
 * （缺口可能在开头或中段，用标记序列表达）。
 */
export function selectMessagesForPrompt(messages: ScoreMessageInput[]): {
	selected: Array<{ index: number; message: ScoreMessageInput }>;
	markers: OmittedMarker[];
} {
	const indexed = messages.map((message, index) => ({ index, message }));
	let selected =
		indexed.length > MAX_MESSAGES
			? [...indexed.slice(0, 10), ...indexed.slice(-(MAX_MESSAGES - 10))]
			: [...indexed];
	// 字符预算：继续从较旧一侧丢，保底 12 条。
	const cost = (m: ScoreMessageInput) => Math.min(m.charCount, PER_MESSAGE_CHAR_CAP) + 32;
	let total = selected.reduce((sum, { message }) => sum + cost(message), 0);
	while (total > TOTAL_CHAR_BUDGET && selected.length > 12) {
		const dropped = selected.shift();
		if (!dropped) break;
		total -= cost(dropped.message);
	}
	const markers: OmittedMarker[] = [];
	let prev = -1;
	for (const { index } of selected) {
		if (index > prev + 1) markers.push({ beforeIndex: index, count: index - prev - 1 });
		prev = index;
	}
	return { selected, markers };
}

/** FNV-1a 32 位哈希 —— 指纹只用于过期判断，无需密码学强度。 */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** 上下文指纹：打分结果是否还有效的判断依据（消息内容以长度代表，够用）。 */
export function computeContextFingerprint(input: ContextScoreInput): string {
	const parts: string[] = [
		input.sessionId,
		input.effectiveSystemPrompt.length.toString(),
		input.toolNames.join(","),
		input.draft ?? "",
	];
	for (const m of input.messages) {
		parts.push(`${m.eventId ?? "-"}|${m.role}|${m.charCount}`);
	}
	return fnv1a(parts.join("\n"));
}

export function buildScoringUserPrompt(input: ContextScoreInput): string {
	const { selected, markers } = selectMessagesForPrompt(input.messages);
	const markerByIndex = new Map(markers.map((m) => [m.beforeIndex, m]));
	const lines: string[] = [];

	lines.push("=== SYSTEM PROMPT (truncated) ===");
	lines.push(
		input.effectiveSystemPrompt.length > 1200
			? `${input.effectiveSystemPrompt.slice(0, 1200)}\n…[truncated, ${input.effectiveSystemPrompt.length} chars total]`
			: input.effectiveSystemPrompt || "(empty)",
	);
	lines.push("");
	lines.push(`=== TOOLS (${input.toolNames.length}) ===`);
	lines.push(input.toolNames.join(", ") || "(none)");
	lines.push("");
	lines.push("=== MESSAGE TRANSCRIPT (oldest first) ===");
	for (const { index, message } of selected) {
		const marker = markerByIndex.get(index);
		if (marker) {
			lines.push(`[… ${marker.count} messages omitted for budget — indexes ${index - marker.count}…${index - 1} …]`);
		}
		const flag = message.sentToLlm ? "" : " [not sent to LLM]";
		lines.push(`--- #${index} [${message.kind}]${flag} ---`);
		lines.push(clipMessage(message.text, message.charCount));
	}
	lines.push("");
	lines.push("=== USER'S NEXT DRAFT (not yet in context) ===");
	lines.push(input.draft?.trim() || "(no draft — judge against the ongoing task)");
	lines.push("");
	lines.push("Audit the context above and respond with the JSON object only.");
	return lines.join("\n");
}

function clampScore(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return undefined;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/** 从模型输出提取 JSON（容忍 ```json 围栏与前后噪声），校验并 clamp。 */
export function parseScoreResponse(raw: string, messages: ScoreMessageInput[]): ContextScoreResult {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1]!.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("打分结果不是合法 JSON");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch (e) {
		throw new Error(`打分结果 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
	}
	const obj = parsed as {
		overall?: unknown;
		dimensions?: unknown;
		summary?: unknown;
		messages?: unknown;
	};

	const overall = clampScore(obj.overall);
	if (overall === undefined) throw new Error("打分结果缺少 overall 分数");

	const dimensions: ContextScoreResult["dimensions"] = [];
	if (Array.isArray(obj.dimensions)) {
		for (const d of obj.dimensions as Array<{ key?: unknown; score?: unknown; comment?: unknown }>) {
			const key = typeof d?.key === "string" ? d.key : "";
			const score = clampScore(d?.score);
			if (!key || score === undefined) continue;
			dimensions.push({
				key,
				score,
				comment: typeof d.comment === "string" ? d.comment.slice(0, 300) : undefined,
			});
		}
	}

	const messageAnnotations: ContextScoreResult["messageAnnotations"] = [];
	if (Array.isArray(obj.messages)) {
		for (const a of obj.messages as Array<{
			index?: unknown;
			message_index?: unknown;
			label?: unknown;
			reason?: unknown;
			suggestion?: unknown;
		}>) {
			if (messageAnnotations.length >= MAX_ANNOTATIONS) break;
			const idxRaw = a?.index ?? a?.message_index;
			const index = typeof idxRaw === "number" ? idxRaw : Number(idxRaw);
			if (!Number.isInteger(index) || index < 0 || index >= messages.length) continue;
			const label = a?.label === "high" || a?.label === "medium" || a?.label === "low" ? a.label : "medium";
			const suggestion =
				a?.suggestion === "keep" || a?.suggestion === "trim" || a?.suggestion === "edit" || a?.suggestion === "delete"
					? a.suggestion
					: undefined;
			messageAnnotations.push({
				eventId: messages[index]?.eventId,
				index,
				label,
				reason: typeof a?.reason === "string" ? a.reason.slice(0, 300) : undefined,
				suggestion,
			});
		}
	}

	return {
		overall,
		dimensions,
		summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 2000) : "",
		messageAnnotations,
		generatedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// 任务状态（进程内单例，同 state.ts 模式；不落盘）
// ---------------------------------------------------------------------------

interface ScoreJob {
	status: ContextScoreJobStatus;
	fingerprint?: string;
	startedAt?: number;
	finishedAt?: number;
	model?: string;
	error?: string;
	result?: ContextScoreResult;
	abort?: AbortController;
}

const job: ScoreJob = { status: "idle" };

function jobSnapshot(): ContextScoreJobSnapshot {
	const snapshot: ContextScoreJobSnapshot = { status: job.status };
	if (job.fingerprint !== undefined) snapshot.fingerprint = job.fingerprint;
	if (job.startedAt !== undefined) snapshot.startedAt = job.startedAt;
	if (job.finishedAt !== undefined) snapshot.finishedAt = job.finishedAt;
	if (job.model !== undefined) snapshot.model = job.model;
	if (job.error !== undefined) snapshot.error = job.error;
	if (job.result !== undefined) snapshot.result = job.result;
	return snapshot;
}

/**
 * 启动一次打分。立即返回（LLM 调用在后台进行）；调用方轮询
 * getContextScoreStatus()。已在跑 → 原样返回；结果未过期且未 force →
 * 直接复用缓存。
 */
export function startContextScore(deps: {
	llmClient: LLMClient;
	model: ModelConfig;
	input: ContextScoreInput;
	force?: boolean;
}): ContextScoreJobSnapshot {
	if (job.status === "running") return jobSnapshot();
	const fingerprint = computeContextFingerprint(deps.input);
	if (!deps.force && job.status === "done" && job.fingerprint === fingerprint) {
		return jobSnapshot();
	}

	job.status = "running";
	job.fingerprint = fingerprint;
	job.startedAt = Date.now();
	job.finishedAt = undefined;
	job.error = undefined;
	job.result = undefined;
	job.model = `${deps.model.provider}/${deps.model.model_id}`;

	const abort = new AbortController();
	job.abort = abort;
	const timeout = setTimeout(() => abort.abort(), SCORE_TIMEOUT_MS);

	void (async () => {
		try {
			const promptText = buildScoringUserPrompt(deps.input);
			const userMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			};
			const response = await deps.llmClient.complete({
				messages: [userMessage],
				systemPrompt: SCORING_SYSTEM_PROMPT,
				model: deps.model,
				tools: [],
				signal: abort.signal,
			});
			if (abort.signal.aborted) {
				// 客户端未随 signal reject 而是晚到正常返回：同样按取消处理。
				job.status = "idle";
				return;
			}
			if (response.stopReason === "aborted") {
				job.status = "idle";
				job.error = "已取消";
				return;
			}
			if (response.stopReason === "error") {
				job.status = "error";
				job.error = `打分调用失败：${response.errorMessage ?? "未知错误"}`;
				return;
			}
			const text = response.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			if (!text.trim()) {
				job.status = "error";
				job.error = "打分模型返回了空内容";
				return;
			}
			job.result = parseScoreResponse(text, deps.input.messages);
			job.status = "done";
		} catch (e) {
			job.status = abort.signal.aborted ? "idle" : "error";
			job.error = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(timeout);
			job.finishedAt = Date.now();
			job.abort = undefined;
		}
	})();

	return jobSnapshot();
}

/** 当前任务状态；currentFingerprint 传入时附带 stale 判断。 */
export function getContextScoreStatus(currentFingerprint?: string): ContextScoreJobSnapshot & { stale?: boolean } {
	const snapshot = jobSnapshot();
	if (snapshot.status === "done" && currentFingerprint !== undefined) {
		snapshot.stale = snapshot.fingerprint !== currentFingerprint;
	}
	return snapshot;
}

export function cancelContextScore(): ContextScoreJobSnapshot {
	if (job.status === "running") job.abort?.abort();
	return jobSnapshot();
}

/** 测试辅助：重置任务状态。 */
export function resetContextScoreForTest(): void {
	job.abort?.abort();
	job.status = "idle";
	job.fingerprint = undefined;
	job.startedAt = undefined;
	job.finishedAt = undefined;
	job.model = undefined;
	job.error = undefined;
	job.result = undefined;
	job.abort = undefined;
}
