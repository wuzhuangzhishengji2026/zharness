/**
 * 全新上下文阶段 episode：每次派发启动一个独立的 zharness 子进程。
 *
 * - 子进程与主进程共享 agentDir（认证/模型）与项目目录，但以 --no-session
 *   跑在独立的内存事件库上（避免与父进程并发写同一 workspace 事件库，
 *   详见 runStageEpisode 内注释），结束后只回传最终文本 ——
 *   中间过程不进入任何长期上下文。
 * - 通过 STAGE_ENV 环境变量标记角色，子进程内的同一份插件据此替换
 *   系统提示词（见 index.ts 的角色子进程模式）。
 */

import { RpcClient } from "../../../packages/rpc/rpc-client.js";
import { ENV_AGENT_DIR } from "../../config.js";
import { getAgentDir } from "../../index.js";
import type { EventBase } from "../../core/event-store/types.js";
import { STAGE_ENV, type StageDefinition, type StageReport } from "./stages.js";

export interface EpisodeResult {
	/** episode 的最终文本（应为一个 JSON 报告） */
	text: string;
	/** 解析后的报告；episode 未按格式返回时为 null，由门禁判定失败 */
	report: StageReport | null;
	/** episode 最终 turn 的停止原因（"length" 表示输出被截断，报告大概率不完整） */
	stopReason?: string;
	/**
	 * episode 最终 turn 以错误结束时携带原始错误信息（如 401 认证失败、
	 * 订阅过期）。编排器据此透传真实原因，而不是误报成「JSON 报告不可解析」。
	 */
	turnError?: string;
}

/**
 * 输出长度截断的自愈上限：stop_reason=length 时向同一 episode 进程补发
 * 续跑提示（上下文保留，模型从截断处继续），最多补 MAX_LENGTH_CONTINUATIONS 轮。
 * 推理模型把输出预算耗尽在 thinking 上时（glm-5.3 实测 16384 token 全烧在
 * 思考、零正文零工具调用），一轮续跑常足以让它直接产出报告。
 */
const MAX_LENGTH_CONTINUATIONS = 2;

const CONTINUATION_PROMPT = [
	"上一次输出因长度限制被截断。",
	"请从截断处继续完成任务，不要重复已输出的内容；",
	"若工作已全部完成，请直接输出最终的纯 JSON 报告（不含任何其他文字）。",
].join("");

/** 从事件流中取最后一个 AGENT_MESSAGE_END 的 stop_reason */
function lastStopReason(events: EventBase[]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "AGENT_MESSAGE_END") continue;
		const payload = event.payload as { stop_reason?: string };
		return payload.stop_reason;
	}
	return undefined;
}

/** 从事件流中取最后一个 turn 的错误信息（AGENT_TURN_COMPLETED reason=error） */
function lastTurnError(events: EventBase[]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "AGENT_TURN_COMPLETED") continue;
		const payload = event.payload as { reason?: string; error_message?: string };
		if (payload.reason === "error" && payload.error_message) return payload.error_message;
		return undefined;
	}
	return undefined;
}

/**
 * 解析 CLI 入口（与 delegate-agent.ts 的 resolveCliSpawn 同构）：
 * node 模式下 argv[1] 是 cli.js 绝对路径；bun --compile 二进制模式下
 * 直接 spawn 可执行文件本身。
 */
function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return { cliPath: isBinary ? process.execPath : argv1, binary: isBinary };
}

/** 派发一个阶段 episode 并等待完成 */
export async function runStageEpisode(
	stage: StageDefinition,
	task: string,
	cwd: string,
): Promise<EpisodeResult> {
	const { cliPath, binary } = resolveCliSpawn();
	const client = new RpcClient({
		cwd,
		cliPath,
		binary,
		// 事件库隔离：episode 以 --no-session 运行在内存事件库上（:memory:）。
		// workspace_id 由 cwd 哈希派生，episode 与父进程（GUI sidecar / CLI）同 cwd
		// 必然解析到同一个 events.sqlite；而 SqliteEventStore 的 sequence 是打开时
		// 一次性读取、之后纯内存递增（sqlite-store.ts _nextSequence），两个写入方
		// 并发追加必然触发 events 表 (workspace_id, sequence) 唯一约束冲突，双方
		// turn 一起崩掉 —— GUI 上的表现就是「第 N/M 次执行…」之后无声无息。
		// episode 的中间过程本就不进入任何长期上下文（只回传最终文本），
		// 内存库既满足隔离，也是设计本意。
		args: ["--no-session"],
		env: {
			// 对齐 agentDir：子进程与主进程共享认证/模型/已知工作区
			[ENV_AGENT_DIR]: getAgentDir(),
			// 角色标记：子进程内的插件据此替换系统提示词 / 拦截写工具
			[STAGE_ENV]: stage.id,
		},
	});
	try {
		await client.start();
		let events = await client.promptAndWait(task, undefined, stage.timeoutMs);
		// length 截断自愈：同一 episode 进程内补发续跑提示（上下文保留）
		let stopReason = lastStopReason(events);
		for (let i = 0; i < MAX_LENGTH_CONTINUATIONS && stopReason === "length"; i++) {
			events = await client.promptAndWait(CONTINUATION_PROMPT, undefined, stage.timeoutMs);
			stopReason = lastStopReason(events);
		}
		const text = (await client.getLastAssistantText()) ?? "";
		return { text, report: parseStageReport(text), stopReason, turnError: lastTurnError(events) };
	} finally {
		await client.stop().catch(() => {});
	}
}

/**
 * 从 episode 最终文本中提取 JSON 报告。
 * 容忍 ```json 围栏与前后杂文字；提取失败返回 null（不抛错 ——
 * 由门禁以「报告不可解析」为证据走统一的重试路径）。
 */
export function parseStageReport(text: string): StageReport | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	for (const candidate of [fenced?.[1], text]) {
		if (!candidate) continue;
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start === -1 || end <= start) continue;
		try {
			return JSON.parse(candidate.slice(start, end + 1)) as StageReport;
		} catch {
			// 尝试下一个候选
		}
	}
	return null;
}
