/**
 * MEA 编排器：代码级状态机。
 *
 * 推进/重试/门禁/确认全部由代码保证，LLM 只在全新上下文的 episode 内
 * 自行生成并执行本阶段工作。两个设计目标的落点：
 *   1. 干净且全新的上下文：每个阶段一个独立子进程 episode（见 episode.ts）。
 *   2. 子阶段自己生成工作：任务消息只含「目标 + 目录指针 + 失败证据」，
 *      不含任何工作内容 —— 工作计划由 episode 读取状态文件后自行拟定。
 *
 * 失败恢复语义（对照 LongHorizon-Harness）：门禁失败不是终点，证据注入
 * 重试；审计发现 high 问题时回退 implement 阶段修复（有界重规划）；
 * 全部尝试耗尽则带着「部分进度 + 证据」强制进入 summary 汇总。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runStageEpisode } from "./episode.js";
import { runGate } from "./gates.js";
import { appendRecord, initPipeline, lastPassedRecord, saveState, type PipelineState } from "./state.js";
import { STAGES, STAGE_ORDER, type StageDefinition, type StageId } from "./stages.js";

/** 同一阶段的最大尝试次数 */
const MAX_STAGE_ATTEMPTS = 3;
/** 整条流水线的 episode 总预算（防止阶段间回退形成无限循环） */
const MAX_TOTAL_EPISODES = 24;
/** 确认对话框中的产物预览行数 */
const CONFIRM_PREVIEW_LINES = 20;
/** notify 单条消息上限（门禁日志尾部可能很长，界面只保留头部） */
const NOTIFY_MAX_CHARS = 600;

/** 编排器与宿主（命令处理器）之间的 IO 接口 */
export interface PipelineIO {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	/** 无 UI 模式下为 undefined：确认点自动通过，驳回回路不可用 */
	input?(title: string, placeholder?: string): Promise<string | undefined>;
}

/** 单个阶段的执行结果（决定编排器的下一步路由） */
type StageOutcome =
	| { kind: "passed" }
	/** 回退到指定阶段重做（如审计发现 high 问题回退 implement） */
	| { kind: "goto"; stage: StageId; evidence: string }
	| { kind: "blocked" }
	| { kind: "abandoned" }
	/** 用户主动中止:不强制 summary,保留断点供 /codegen resume 恢复 */
	| { kind: "aborted" };

/**
 * 构造 episode 的任务消息 —— 注意：这里刻意不含任何工作内容，
 * 只提供目标、目录指针与（重试时的）失败证据。
 */
function buildTaskMessage(goal: string, cwd: string, stage: StageDefinition, attempt: number, evidence: string): string {
	const lines = [
		"【任务目标】",
		goal,
		"",
		"【项目目录】",
		`${cwd}（过程产物统一放在 .codegen/ 目录）`,
		"",
		"请按系统提示词的角色要求，自行读取所需文件，自行拟定并完成本阶段工作。",
	];
	if (evidence) {
		lines.push("", `【重试证据】（前次失败原因，请优先解决）`, evidence);
	}
	return lines.join("\n");
}

/** 确认点预览：展示本阶段产物的开头若干行，帮助用户决策 */
function confirmPreview(cwd: string, stage: StageDefinition): string {
	const artifact = stage.id === "design" ? "design.md" : "requirement.md";
	const path = join(cwd, ".codegen", artifact);
	try {
		const head = readFileSync(path, "utf-8").split("\n").slice(0, CONFIRM_PREVIEW_LINES).join("\n");
		return `阶段「${stage.title}」门禁已通过。${artifact} 预览：\n\n${head}\n\n是否确认继续？`;
	} catch {
		return `阶段「${stage.title}」门禁已通过。是否确认继续？`;
	}
}

/** 失败通知：证据可能很长（门禁日志尾部），界面消息截断保留头部 */
function truncateNotify(text: string): string {
	return text.length > NOTIFY_MAX_CHARS ? `${text.slice(0, NOTIFY_MAX_CHARS)}…` : text;
}

function notifyFailure(io: PipelineIO, stageTitle: string, attempt: number, evidence: string): void {
	io.notify(`[${stageTitle}] 第 ${attempt}/${MAX_STAGE_ATTEMPTS} 次尝试失败：${truncateNotify(evidence)}`, "warning");
}

/**
 * 判定 API 错误是否「重试无意义」：认证失败 / 订阅过期 / key 不存在
 * 这类错误重试 N 次结果相同，应立即阻塞并让用户看到真实原因，
 * 而不是烧完 3 次尝试还报告成误导性的「JSON 报告不可解析」。
 */
function isNonRetryableApiError(message: string): boolean {
	return /AuthenticationError|AuthorizationError|InvalidSubscription|\b(401|403)\b|API key doesn't exist|subscription has expired/i.test(
		message,
	);
}

/** 运行单个阶段（含重试与确认点），返回路由决策 */
async function runStage(
	stage: StageDefinition,
	state: PipelineState,
	cwd: string,
	goal: string,
	io: PipelineIO,
	episodes: { count: number },
	retryEvidence: string,
	shouldAbort?: () => boolean,
): Promise<StageOutcome> {
	for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt++) {
		// 用户中止:当前 episode 跑完即停(episode 无中断钩子),不派发新尝试
		if (shouldAbort?.()) {
			return { kind: "aborted" };
		}
		if (episodes.count >= MAX_TOTAL_EPISODES) {
			io.notify(`已达流水线总预算（${MAX_TOTAL_EPISODES} 个 episode）`, "warning");
			return { kind: "blocked" };
		}
		episodes.count++;
		state.attempt = attempt;
		saveState(cwd, state);
		io.notify(`[${stage.title}] 第 ${attempt}/${MAX_STAGE_ATTEMPTS} 次执行…`);

		// ① 派发全新上下文 episode；episode 级异常（超时/崩溃）视作门禁失败
		let report = null;
		try {
			const task = buildTaskMessage(goal, cwd, stage, attempt, retryEvidence);
			const episodeResult = await runStageEpisode(stage, task, cwd);
			report = episodeResult.report;
			// episode 最终 turn 以错误结束（如 401 认证失败/订阅过期）：
			// 透传原始错误作为证据 —— 这不是格式问题，不能报成「JSON 不可解析」
			if (episodeResult.turnError) {
				const evidence = `episode 模型调用失败：${episodeResult.turnError}`;
				appendRecord(cwd, state, { stage: stage.id, attempt, status: "failed", evidence });
				if (isNonRetryableApiError(episodeResult.turnError)) {
					io.notify(
						`[${stage.title}] 模型调用失败（认证/订阅类错误，不重试）：${truncateNotify(evidence)}。请检查 API key 与订阅状态后用 /codegen resume 恢复`,
						"error",
					);
					return { kind: "blocked" };
				}
				notifyFailure(io, stage.title, attempt, evidence);
				retryEvidence = evidence;
				continue;
			}
			// 输出被长度截断时报告多半不完整 —— 追加到证据，帮助定位
			if (!report && episodeResult.stopReason === "length") {
				const evidence =
					"最后一条消息不是合法的 JSON 报告，且 episode 最终 turn 因输出长度上限被截断（thinking/正文超预算，报告未完整生成）";
				appendRecord(cwd, state, { stage: stage.id, attempt, status: "failed", evidence });
				notifyFailure(io, stage.title, attempt, evidence);
				retryEvidence = evidence;
				continue;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const evidence = `episode 异常：${message}`;
			appendRecord(cwd, state, { stage: stage.id, attempt, status: "failed", evidence });
			notifyFailure(io, stage.title, attempt, evidence);
			retryEvidence = evidence;
			continue;
		}

		// ② 报告解析失败 / 主动阻塞
		if (!report) {
			const evidence = "最后一条消息不是合法的 JSON 报告（必须是纯 JSON，无附加文字）";
			appendRecord(cwd, state, { stage: stage.id, attempt, status: "failed", evidence });
			notifyFailure(io, stage.title, attempt, evidence);
			retryEvidence = evidence;
			continue;
		}
		if (report.status === "blocked") {
			appendRecord(cwd, state, { stage: stage.id, attempt, status: "blocked", summary: report.summary });
			io.notify(`[${stage.title}] episode 报告阻塞：${report.summary}`, "warning");
			return { kind: "blocked" };
		}

		// ③ 确定性门禁：代码检验环境真相
		const gate = await runGate(stage.id, cwd, report);
		if (!gate.passed) {
			appendRecord(cwd, state, { stage: stage.id, attempt, status: "failed", summary: report.summary, evidence: gate.evidence });
			notifyFailure(io, stage.title, attempt, `门禁未通过。${gate.evidence}`);
			// 审计发现 high 问题 → 回退 implement 修复（证据随行）
			if (gate.retryStage && gate.retryStage !== stage.id) {
				return { kind: "goto", stage: gate.retryStage, evidence: gate.evidence };
			}
			retryEvidence = gate.evidence;
			continue;
		}

		// ④ 合规确认点（仅交互模式；无 UI 时由宿主自动通过）
		if (stage.confirmAfter) {
			const approved = await io.confirm(stage.confirmAfter, confirmPreview(cwd, stage));
			if (!approved) {
				const feedback = io.input ? ((await io.input("修改意见", "请说明驳回原因与期望的修改")) ?? "") : "";
				if (!feedback.trim()) {
					return { kind: "abandoned" };
				}
				appendRecord(cwd, state, { stage: stage.id, attempt, status: "user-rejected", evidence: feedback });
				retryEvidence = `用户驳回本阶段产物：${feedback}`;
				continue;
			}
		}

		// ⑤ 通过：记录已验证事实（changedFiles 为门禁验证过的文件清单）
		appendRecord(cwd, state, {
			stage: stage.id,
			attempt,
			status: "passed",
			summary: report.summary,
			changedFiles: report.changedFiles,
		});
		io.notify(`[${stage.title}] 通过：${gate.evidence}`, "info");
		return { kind: "passed" };
	}
	// 本阶段尝试耗尽
	return { kind: "blocked" };
}

/**
 * 运行完整流水线。返回最终状态（outcome：completed / blocked / abandoned）。
 * 无论中间是否失败，都会强制经过 summary 阶段产出汇总 —— 失败也交付证据。
 *
 * 传入 `resume` 时从既有状态断点续跑：已 passed 的阶段直接跳过，
 * 起点阶段的最近失败证据注入首个 episode（records 审计轨迹保留）。
 */
export async function runPipeline(
	goal: string,
	cwd: string,
	io: PipelineIO,
	resume?: PipelineState,
	shouldAbort?: () => boolean,
): Promise<PipelineState> {
	const state = resume ?? initPipeline(cwd, goal);
	// 断点续跑清除上次的终态字段
	delete state.outcome;
	delete state.finishedAt;

	const episodes = { count: 0 };
	const summaryIndex = STAGE_ORDER.indexOf("summary");
	let retryEvidence = "";
	let si = 0;

	if (resume) {
		// 起点 = 第一个没有 passed 记录的阶段（其后 failed 的阶段从这里重做）
		const firstUnpassed = STAGE_ORDER.findIndex((id) => !lastPassedRecord(resume, id));
		si = firstUnpassed === -1 ? STAGE_ORDER.length : firstUnpassed;
		if (si < STAGE_ORDER.length) {
			const startStage = STAGE_ORDER[si];
			const lastFailure = [...resume.records]
				.reverse()
				.find((r) => r.stage === startStage && r.status === "failed" && r.evidence);
			retryEvidence = lastFailure?.evidence ?? "";
			io.notify(`从断点恢复：跳过已通过阶段，从「${STAGES[startStage].title}」继续`, "info");
		}
	}

	while (si < STAGE_ORDER.length) {
		const stage = STAGES[STAGE_ORDER[si]];
		state.stageIndex = si;
		saveState(cwd, state);
		const outcome = await runStage(stage, state, cwd, goal, io, episodes, retryEvidence, shouldAbort);

		if (outcome.kind === "aborted") {
			// 用户中止:保留断点(不清终态时间),供 /codegen resume 恢复
			state.outcome = "aborted";
			saveState(cwd, state);
			io.notify("流水线已被用户中止。断点已保留，可用「恢复」继续。", "warning");
			return state;
		}
		if (outcome.kind === "passed") {
			retryEvidence = "";
			si++;
			continue;
		}
		if (outcome.kind === "goto") {
			io.notify(`[${stage.title}] 回退到 ${outcome.stage} 阶段修复`, "warning");
			retryEvidence = outcome.evidence;
			si = STAGE_ORDER.indexOf(outcome.stage);
			continue;
		}
		// blocked / abandoned：带着证据强制进入 summary（summary 本身失败则终止）
		state.outcome ??= outcome.kind === "abandoned" ? "abandoned" : "blocked";
		if (si === summaryIndex) break;
		si = summaryIndex;
	}

	state.outcome ??= "completed";
	state.finishedAt = new Date().toISOString();
	saveState(cwd, state);
	io.notify(`流水线结束：${state.outcome}。汇总见 .codegen/summary.md，轨迹见 .codegen/state.json`, "info");
	return state;
}
