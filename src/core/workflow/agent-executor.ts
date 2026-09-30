/**
 * RpcClient 子代理执行器:动态工作流 agent().ask() 的生产实现。
 *
 * 每个命名 actor 维持一个 zharness RPC 子进程(完整工具集、独立会话
 * 上下文),同一 actor 的多个 ask 在同一进程里先后执行 —— 上下文跨任务
 * 累积,这正是「持久子代理」的实现;engine 已保证同 actor 的 ask 串行,
 * 执行器只管把任务送进对应进程并取回最终回复。
 *
 * 派生方式与 delegate_agent 工具一致:以当前 CLI 入口 `--mode rpc`
 * spawn,agentDir 通过 ZHARNESS_CODING_AGENT_DIR 与主进程对齐(共享
 * 认证/模型配置)。子代理结束后 disposeAll 统一回收进程。
 */

import { ENV_AGENT_DIR } from "../../config.js";
import { RpcClient } from "../../../packages/rpc/rpc-client.js";
import type { SubagentAskRequest, SubagentExecutor } from "./types.js";

/** 与 delegate_agent 相同的 CLI 入口解析(node 模式 / bun 二进制模式)。 */
function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return {
		cliPath: isBinary ? process.execPath : argv1,
		binary: isBinary,
	};
}

export interface RpcSubagentExecutorOptions {
	/** 子代理的工作目录(工作区)。 */
	cwd: string;
	/** agent 目录(共享认证/模型;默认取当前进程的 agentDir)。 */
	agentDir: string;
	/** cliPath/binary 显式覆盖(测试或自定义安装)。 */
	cliPath?: string;
	binary?: boolean;
	/** provider/model 覆盖(缺省继承 CLI 默认)。 */
	provider?: string;
	model?: string;
	/** 单任务超时(缺省 10 分钟;engine 传入 request.timeoutMs 时以其为准的较小值)。 */
	defaultTimeoutMs?: number;
}

interface ActorSession {
	client: RpcClient;
	/** 进程启动失败/退出后置 true;该 actor 的后续 ask 直接失败。 */
	broken: string | undefined;
}

export function createRpcSubagentExecutor(options: RpcSubagentExecutorOptions): SubagentExecutor {
	const spawnInfo = options.cliPath
		? { cliPath: options.cliPath, binary: options.binary ?? false }
		: resolveCliSpawn();
	const sessions = new Map<string, ActorSession>();

	const sessionFor = async (actorId: string): Promise<ActorSession> => {
		const existing = sessions.get(actorId);
		if (existing) {
			if (existing.broken) throw new Error(`subagent context lost: ${existing.broken}`);
			return existing;
		}
		const client = new RpcClient({
			cwd: options.cwd,
			cliPath: spawnInfo.cliPath,
			binary: spawnInfo.binary,
			env: { [ENV_AGENT_DIR]: options.agentDir },
			provider: options.provider,
			model: options.model,
		});
		const session: ActorSession = { client, broken: undefined };
		sessions.set(actorId, session);
		try {
			await client.start();
		} catch (error) {
			session.broken = error instanceof Error ? error.message : String(error);
			void client.stop().catch(() => {});
			throw new Error(
				`failed to start sub-agent process: ${session.broken}${client.getStderr() ? `\n--- stderr ---\n${client.getStderr()}` : ""}`,
			);
		}
		return session;
	};

	return {
		async ask(request: SubagentAskRequest): Promise<string> {
			const session = await sessionFor(request.actorId);
			const timeout = Math.min(
				request.timeoutMs,
				options.defaultTimeoutMs ?? Number.POSITIVE_INFINITY,
			);
			try {
				await session.client.promptAndWait(request.instructions, undefined, timeout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// 一次失败的回合之后上下文状态不可信:标记断开并回收进程。
				session.broken = message;
				void session.client.stop().catch(() => {});
				throw new Error(
					`sub-agent "${request.actorName}" turn failed: ${message}`,
				);
			}
			const text = await session.client.getLastAssistantText();
			if (text === null || !text.trim()) {
				session.broken = "empty final reply";
				void session.client.stop().catch(() => {});
				throw new Error(`sub-agent "${request.actorName}" produced no final reply`);
			}
			return text;
		},
		async dispose(actorId: string): Promise<void> {
			const session = sessions.get(actorId);
			sessions.delete(actorId);
			if (session) await session.client.stop().catch(() => {});
		},
		async disposeAll(): Promise<void> {
			const all = [...sessions.values()];
			sessions.clear();
			await Promise.all(all.map((s) => s.client.stop().catch(() => {})));
		},
	};
}
