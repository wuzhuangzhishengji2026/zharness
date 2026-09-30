/**
 * 动态工作流引擎:SOP(kind: dynamic)脚本的编排运行时。
 *
 * 职责(模型对齐 ZCode CreateWorkflow,实现收敛到 zharness 现有原语):
 * - 把 workflow.ts 包一层 async 函数经 jiti 转译执行,注入 facade
 *   (agent/ask/phase/log/report/world/files/git/artifact/args);
 * - agent() 维护持久子代理(名字唯一;同一 actor 的 ask FIFO 串行,
 *   全局并发受信号量约束);typed ask({of}) 用脚本内 interface 声明
 *   组装 JSON 契约并解析子代理回复;
 * - world.run 走命令执行器,退出码是值;spawn 失败/超时才 reject;
 * - 每次运行落一份 journal(<agentDir>/sop-runs/<runId>/: meta.json +
 *   journal.jsonl + script.ts),渐进结果(report)与产物随结局交付,
 *   失败的运行也保住已完成的工作;
 * - 运行注册表支持 stop(中止进行中的运行)与 list(枚举历史运行)。
 *
 * 子代理与命令的具体执行通过 SubagentExecutor / WorkflowCommandExecutor
 * 注入:生产路径分别是 RpcClient 子代理进程(见 agent-executor.ts)与
 * execCommand;测试注入 stub,不触网。
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { minimatch } from "minimatch";
import { createJiti } from "@mariozechner/jiti";
import { getAgentDir } from "../../config.js";
import { execCommand } from "../exec.js";
import type { SopArgDef } from "../sop.js";
import { extractInterfaces, extractJsonResult } from "./interfaces.js";
import type {
	SubagentAskRequest,
	SubagentExecutor,
	WorkflowAgent,
	WorkflowArtifactOptions,
	WorkflowArtifactRecord,
	WorkflowCommandExecutor,
	WorkflowCommandResult,
	WorkflowFacade,
	WorkflowProgressEvent,
	WorkflowReportItem,
	WorkflowRunOutcome,
	WorkflowRunStatus,
} from "./types.js";

// ============================================================================
// 默认执行器
// ============================================================================

/** 默认命令执行器:world.run / git 的底层,基于共享 execCommand。 */
export function createDefaultCommandExecutor(): WorkflowCommandExecutor {
	return {
		async run(command, args, options): Promise<WorkflowCommandResult> {
			const result = await execCommand(command, args, options?.cwd ?? process.cwd(), {
				timeout: options?.timeoutMs,
				signal: options?.signal,
			});
			return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
		},
	};
}

// ============================================================================
// 运行记录(journal)
// ============================================================================

/** 已结束或进行中运行的摘要(listWorkflowRuns 返回)。 */
export interface WorkflowRunSummary {
	runId: string;
	slug: string;
	name: string;
	status: WorkflowRunStatus;
	startedAt: number;
	endedAt?: number;
	stopReason?: string;
	error?: string;
	conclusion?: string;
}

interface JournalSink {
	dir: string;
	append(event: Record<string, unknown>): void;
}

function createJournalSink(dir: string): JournalSink {
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		append(event) {
			try {
				appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
			} catch {
				// journal 尽力而为:写不进不应拖垮运行
			}
		},
	};
}

function writeMeta(sink: JournalSink, meta: Record<string, unknown>): void {
	try {
		writeFileSync(join(sink.dir, "meta.json"), JSON.stringify(meta, null, "\t"), "utf-8");
	} catch {
		// 同上,尽力而为
	}
}

/** 运行记录根目录:<agentDir>/sop-runs。 */
export function getWorkflowRunsRoot(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "sop-runs");
}

/** 枚举历史运行(读 meta.json,按启动时间倒序;进行中的以内存注册表为准)。 */
export function listWorkflowRuns(agentDir?: string): WorkflowRunSummary[] {
	const root = getWorkflowRunsRoot(agentDir);
	const summaries: WorkflowRunSummary[] = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let meta: Record<string, unknown>;
		try {
			meta = JSON.parse(readFileSync(join(root, entry.name, "meta.json"), "utf-8"));
		} catch {
			continue;
		}
		const running = runningRuns.get(entry.name);
		summaries.push({
			runId: typeof meta.runId === "string" ? meta.runId : entry.name,
			slug: typeof meta.slug === "string" ? meta.slug : "(unknown)",
			name: typeof meta.name === "string" ? meta.name : "(unknown)",
			status: running ? running.status : (meta.status as WorkflowRunStatus) ?? "errored",
			startedAt: typeof meta.startedAt === "number" ? meta.startedAt : 0,
			endedAt: typeof meta.endedAt === "number" ? meta.endedAt : undefined,
			stopReason: typeof meta.stopReason === "string" ? meta.stopReason : undefined,
			error: typeof meta.error === "string" ? meta.error : undefined,
			conclusion: typeof meta.conclusion === "string" ? meta.conclusion : undefined,
		});
	}
	summaries.sort((a, b) => b.startedAt - a.startedAt);
	return summaries;
}

/** 按运行 id 取摘要(进行中优先查内存注册表)。 */
export function getWorkflowRunSummary(runId: string, agentDir?: string): WorkflowRunSummary | null {
	const running = runningRuns.get(runId);
	if (running) return running.getSummary();
	return listWorkflowRuns(agentDir).find((s) => s.runId === runId) ?? null;
}

// ============================================================================
// 参数校验
// ============================================================================

/** 按 SOP 声明校验启动参数:填默认值;必填缺失返回错误列表。 */
export function validateWorkflowArgs(
	argDefs: SopArgDef[],
	provided: Record<string, unknown>,
): { values: Record<string, unknown>; errors: string[] } {
	const values: Record<string, unknown> = { ...provided };
	const errors: string[] = [];
	for (const def of argDefs) {
		if (values[def.name] === undefined && def.default !== undefined) values[def.name] = def.default;
		if (values[def.name] === undefined && def.required) {
			errors.push(`missing required argument "${def.name}"${def.description ? ` (${def.description})` : ""}`);
		}
	}
	return { values, errors };
}

// ============================================================================
// 运行句柄
// ============================================================================

/** 一次运行的可操作句柄。 */
export interface WorkflowRunHandle {
	runId: string;
	status: WorkflowRunStatus;
	/** 运行结局(始终 settle;失败运行也携带渐进结果与产物)。 */
	promise: Promise<WorkflowRunOutcome>;
	/** 中止运行(等待中的 ask/命令会失败,运行以 stopped 结束)。 */
	stop(reason?: "user" | "model"): void;
	getSummary(): WorkflowRunSummary;
}

interface RunningRun {
	status: WorkflowRunStatus;
	stop(reason?: "user" | "model"): void;
	getSummary(): WorkflowRunSummary;
}

/** 进程内进行中的运行(重启后由磁盘 meta.json 接手枚举)。 */
const runningRuns = new Map<string, RunningRun>();

/** 停止一个进行中的运行。返回是否找到了该运行。 */
export function stopWorkflowRun(runId: string, reason: "user" | "model" = "user"): boolean {
	const run = runningRuns.get(runId);
	if (!run) return false;
	run.stop(reason);
	return true;
}

// ============================================================================
// 引擎选项与启动
// ============================================================================

export interface WorkflowEngineOptions {
	/** 子代理执行器(必需;生产路径见 agent-executor.ts)。 */
	subagentExecutor: SubagentExecutor;
	/** 命令执行器(缺省用 execCommand)。 */
	commandExecutor?: WorkflowCommandExecutor;
	/** 工作区目录(world/files/git/artifact 的相对路径基准)。 */
	cwd: string;
	/** agent 目录(journal 根;缺省 getAgentDir())。 */
	agentDir?: string;
	/** 子代理并发上限(默认 4)。 */
	concurrency?: number;
	/** 单个 ask 的超时(默认 10 分钟)。 */
	askTimeoutMs?: number;
	/** 进度回调(状态行更新等)。 */
	onEvent?: (event: WorkflowProgressEvent) => void;
}

export interface StartWorkflowOptions {
	slug: string;
	name: string;
	scriptSource: string;
	args?: Record<string, unknown>;
	argDefs?: SopArgDef[];
	concurrency?: number;
}

/** 脚本包装的前缀行数(journal 里保存包装后文件,报错行号据此换算)。 */
const WRAPPER_PREFIX_LINES = 3;

/** 注入子代理首个任务的通用契约(对齐 ZCode 工作流子代理的基线行为)。 */
const SUBAGENT_CONTRACT = [
	"【子代理基线】",
	 "- 你拥有完整的工具(读/找/改/运行命令);指令没让你改的东西就不要改。",
	 "- 引用证据时给出具体位置(文件路径与行号/命令与输出),没核实的事直说没核实。",
	 "- 任务无法完成或指令相互矛盾时,如实返回失败原因,不要编造结果。",
	 "",
].join("\n");

/** 启动一次动态工作流运行。返回句柄;运行在后台推进,经 promise 交付结局。 */
export async function startWorkflowRun(
	start: StartWorkflowOptions,
	engineOptions: WorkflowEngineOptions,
): Promise<WorkflowRunHandle> {
	const concurrency = Math.max(1, start.concurrency ?? engineOptions.concurrency ?? 4);
	const askTimeoutMs = engineOptions.askTimeoutMs ?? 10 * 60_000;
	const cwd = resolve(engineOptions.cwd);
	const runId = `run-${randomUUID()}`;
	const sink = createJournalSink(join(getWorkflowRunsRoot(engineOptions.agentDir), runId));
	const commandExecutor = engineOptions.commandExecutor ?? createDefaultCommandExecutor();
	const interfaces = extractInterfaces(start.scriptSource);
	const onEvent = engineOptions.onEvent;

	// ------------------------------------------------------------------
	// 参数校验(启动前完成;失败直接抛错,不产生运行记录)
	// ------------------------------------------------------------------
	let argValues: Record<string, unknown> = {};
	if (start.argDefs && start.argDefs.length > 0) {
		const { values, errors } = validateWorkflowArgs(start.argDefs, start.args ?? {});
		if (errors.length > 0) {
			throw new Error(`invalid arguments: ${errors.join("; ")}`);
		}
		argValues = values;
	} else {
		argValues = { ...(start.args ?? {}) };
	}

	// ------------------------------------------------------------------
	// facade 装配
	// ------------------------------------------------------------------
	const phases: string[] = [];
	const reports: WorkflowReportItem[] = [];
	const artifacts: WorkflowArtifactRecord[] = [];
	let agentsCreated = 0;

	const emit = (event: WorkflowProgressEvent): void => {
		try {
			onEvent?.(event);
		} catch {
			// 回调异常不影响运行
		}
	};

	// 并发信号量
	let active = 0;
	const waiters: Array<() => void> = [];
	const acquire = async (): Promise<void> => {
		if (active < concurrency) {
			active++;
			return;
		}
		await new Promise<void>((res) => waiters.push(res));
		active++;
	};
	const release = (): void => {
		active--;
		const next = waiters.shift();
		if (next) next();
	};

	// actor 注册表
	interface ActorState {
		id: string;
		name: string;
		persona?: string;
		askCount: number;
		chain: Promise<unknown>;
	}
	const actors = new Map<string, ActorState>();
	const actorNames = new Set<string>();
	let anonSeq = 0;

	const makeAsk =
		(actor: ActorState) =>
		async (instructions: string, options?: { of?: string }): Promise<unknown> => {
			if (typeof instructions !== "string" || !instructions.trim()) {
				throw new Error(`agent "${actor.name}": ask() requires non-empty instructions`);
			}
			let shapeSource: string | undefined;
			let shapeName: string | undefined;
			if (options?.of) {
				shapeName = options.of;
				shapeSource = interfaces.get(shapeName);
				if (!shapeSource) {
					throw new Error(
						`agent "${actor.name}": ask(..., { of: "${shapeName}" }) references an interface not declared in the script`,
					);
				}
			}
			const parts: string[] = [];
			if (actor.askCount === 0) {
				if (actor.persona) parts.push(`【角色设定】${actor.persona}\n`);
				parts.push(SUBAGENT_CONTRACT);
			}
			parts.push(instructions);
			if (shapeSource) {
				parts.push(
					[
						"",
						"【结果契约】最终回复必须以一个 ```json 围栏块结尾,内容是符合下面 TypeScript 接口的 JSON 对象(/** */ 注释即字段说明,数组字段用 JSON 数组):",
						"```ts",
						shapeSource,
						"```",
						"围栏块之外最多加两三句说明,不要放长内容。",
					].join("\n"),
				);
			}
			const request: SubagentAskRequest = {
				runId,
				actorId: actor.id,
				actorName: actor.name,
				isFirstAsk: actor.askCount === 0,
				instructions: parts.join("\n"),
				timeoutMs: askTimeoutMs,
			};
			const startedAt = Date.now();
			sink.append({ t: "ask_started", actor: actor.name, shape: options?.of, instructions: request.instructions });
			emit({ type: "ask_started", actorName: actor.name });
			let text: string;
			try {
				await acquire();
				try {
					text = await engineOptions.subagentExecutor.ask(request);
				} finally {
					release();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sink.append({ t: "ask_failed", actor: actor.name, error: message, ms: Date.now() - startedAt });
				emit({ type: "ask_failed", actorName: actor.name, error: message });
				throw error;
			}
			actor.askCount++;
			if (shapeSource) {
				const parsed = extractJsonResult(text ?? "");
				if (parsed === undefined || parsed === null || typeof parsed !== "object") {
				const error = new Error(
					`agent "${actor.name}" did not return the required JSON result (interface ${shapeName}); ` +
						"reply did not contain a parsable ```json block",
				);
					sink.append({ t: "ask_failed", actor: actor.name, error: error.message, ms: Date.now() - startedAt });
					emit({ type: "ask_failed", actorName: actor.name, error: error.message });
					throw error;
				}
				sink.append({ t: "ask_completed", actor: actor.name, ms: Date.now() - startedAt, result: parsed });
				emit({ type: "ask_completed", actorName: actor.name, ms: Date.now() - startedAt });
				return parsed;
			}
			sink.append({ t: "ask_completed", actor: actor.name, ms: Date.now() - startedAt, result: (text ?? "").slice(0, 2000) });
			emit({ type: "ask_completed", actorName: actor.name, ms: Date.now() - startedAt });
			return (text ?? "").trim();
		};

	const facade: WorkflowFacade = {
		agent(rawName?: string, persona?: string | { system?: string }) {
			const name = typeof rawName === "string" ? rawName.trim() : "";
			if (name) {
				if (actorNames.has(name)) {
					throw new Error(`duplicate agent name "${name}": every named agent in one run must be unique`);
				}
				actorNames.add(name);
			}
			const personaText =
				typeof persona === "string" ? persona.trim() : persona?.system?.trim() || undefined;
			const actor: ActorState = {
				id: name || `anon-${++anonSeq}`,
				name: name || `子代理-${anonSeq}`,
				persona: personaText,
				askCount: 0,
				chain: Promise.resolve(),
			};
			agentsCreated++;
			sink.append({ t: "agent_created", actor: actor.name, persona: personaText });
			actors.set(actor.id, actor);
			// 同一 actor 的 ask 串成 FIFO 链;执行体挂到链上而不是立刻跑。
			const askFn = (instructions: string, options?: { of?: string }) => {
				const task = actor.chain.then(() => makeAsk(actor)(instructions, options));
				actor.chain = task.then(
					() => undefined,
					() => undefined,
				);
				return task;
			};
			return { ask: askFn } as WorkflowAgent;
		},
		log(message: string) {
			sink.append({ t: "log", message });
		},
		phase(name: string) {
			if (phases[phases.length - 1] !== name) phases.push(name);
			sink.append({ t: "phase", name });
			emit({ type: "phase", name });
		},
		report(item: unknown, tag?: string) {
			reports.push({ item, tag });
			sink.append({ t: "report", item, tag });
			emit({ type: "report", tag });
		},
		world: {
			async run(command, args, options) {
				if (typeof command !== "string" || !command.trim()) {
					throw new Error("world.run: command must be a literal command name");
				}
				const startedAt = Date.now();
				sink.append({ t: "command_started", command, args });
				let result: WorkflowCommandResult;
				try {
					result = await commandExecutor.run(command, args, {
						cwd,
						timeoutMs: options?.timeoutMs,
						signal: controller.signal,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					sink.append({ t: "command_failed", command, args, error: message, ms: Date.now() - startedAt });
					emit({ type: "command", command, exitCode: -1 });
					throw new Error(`world.run("${command}") failed to execute: ${message}`);
				}
				sink.append({
					t: "command",
					command,
					args,
					exitCode: result.exitCode,
					ms: Date.now() - startedAt,
					stdout: result.stdout.slice(0, 8000),
					stderr: result.stderr.slice(0, 8000),
				});
				emit({ type: "command", command, exitCode: result.exitCode });
				return result;
			},
		},
		files: {
			async glob(pattern: string): Promise<string[]> {
				const matches: string[] = [];
				const skip = new Set(["node_modules", ".git"]);
				const visit = (dir: string, depth: number): void => {
					if (matches.length > 5000) return;
					if (depth > 12) return;
					let entries;
					try {
						entries = readdirSync(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of entries) {
						if (skip.has(entry.name)) continue;
						const full = join(dir, entry.name);
						const rel = relative(cwd, full).split(sep).join("/");
						if (entry.isDirectory()) {
							visit(full, depth + 1);
						} else if (minimatch(rel, pattern, { dot: true })) {
							matches.push(rel);
						}
						if (matches.length > 5000) return;
					}
				};
				visit(cwd, 0);
				if (matches.length > 5000) {
					throw new Error(`files.glob("${pattern}"): too many matches (>5000) — narrow the pattern`);
				}
				matches.sort();
				sink.append({ t: "glob", pattern, count: matches.length });
				return matches;
			},
			async read(path: string): Promise<string> {
				const full = resolveInWorkspace(cwd, path);
				let content: string;
				try {
					content = readFileSync(full, "utf-8");
				} catch (error) {
					throw new Error(`files.read("${path}") failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (Buffer.byteLength(content, "utf-8") > 512 * 1024) {
					throw new Error(`files.read("${path}"): file over the 512KB cap — hand the path to a subagent instead`);
				}
				sink.append({ t: "read", path });
				return content;
			},
		},
		git: {
			async changedFiles(base?: string): Promise<string[]> {
				const ref = base ?? "HEAD";
				const result = await commandExecutor.run("git", ["diff", "--name-only", ref], {
					cwd,
					signal: controller.signal,
				});
				if (result.exitCode !== 0) {
					throw new Error(`git.changedFiles("${ref}") failed: ${result.stderr.trim() || result.stdout.trim()}`);
				}
				const files = result.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0);
				sink.append({ t: "git_changed", base: ref, count: files.length });
				return files;
			},
		},
		artifact: {
			async file(id: string, path: string, options?: WorkflowArtifactOptions): Promise<void> {
				assertArtifactId(id);
				const full = resolveInWorkspace(cwd, path);
				if (!existsSync(full)) {
					throw new Error(`artifact.file("${id}"): "${path}" does not exist in the workspace`);
				}
				const record: WorkflowArtifactRecord = {
					id,
					kind: "file",
					path: relative(cwd, full).split(sep).join("/"),
					...options,
				};
				artifacts.push(record);
				sink.append({ t: "artifact", ...record });
				emit({ type: "artifact", id });
			},
			async markdown(id: string, content: string, options?: WorkflowArtifactOptions): Promise<void> {
				assertArtifactId(id);
				const outDir = join(cwd, "out", "sop-runs", runId);
				mkdirSync(outDir, { recursive: true });
				const target = join(outDir, `${id}.md`);
				writeFileSync(target, content, "utf-8");
				const record: WorkflowArtifactRecord = {
					id,
					kind: "markdown",
					path: relative(cwd, target).split(sep).join("/"),
					...options,
				};
				artifacts.push(record);
				sink.append({ t: "artifact", ...record });
				emit({ type: "artifact", id });
			},
		},
		args: argValues,
	};

	// ------------------------------------------------------------------
	// 中止控制
	// ------------------------------------------------------------------
	const controller = new AbortController();
	let stopReason: "user" | "model" | undefined;

	// ------------------------------------------------------------------
	// 脚本包装与执行
	// ------------------------------------------------------------------
	const wrapped = [
		`// ${start.slug} — dynamic SOP workflow script (auto-wrapped; do not edit)`,
		"export default async (__facade: any) => {",
		"const { agent, log, phase, report, world, files, git, artifact, args } = __facade;",
		start.scriptSource,
		"};",
	].join("\n");
	const wrappedPath = join(sink.dir, "script.ts");
	writeFileSync(wrappedPath, wrapped, "utf-8");

	const startedAt = Date.now();
	let status: WorkflowRunStatus = "running";
	sink.append({ t: "run_started", runId, slug: start.slug, name: start.name, args: argValues, ts: startedAt });
	writeMeta(sink, { runId, slug: start.slug, name: start.name, status, startedAt, args: argValues });

	const outcomePromise = (async (): Promise<WorkflowRunOutcome> => {
		let result: unknown;
		let error: string | undefined;
		try {
			const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
			const loaded = (await jiti.import(wrappedPath, { default: true })) as unknown;
			const run =
				typeof loaded === "function"
					? loaded
					: typeof (loaded as { default?: unknown })?.default === "function"
						? (loaded as { default: (facade: WorkflowFacade) => Promise<unknown> }).default
						: undefined;
			if (typeof run !== "function") {
				throw new Error("workflow script must be a plain script (top-level statements), not a module export");
			}
			result = await run(facade);
			status = "completed";
		} catch (caught) {
			if (controller.signal.aborted) {
				status = "stopped";
				stopReason = (controller.signal.reason as "user" | "model") ?? "user";
			} else {
				status = "errored";
				error = adjustScriptError(caught, wrappedPath);
			}
		} finally {
			try {
				await engineOptions.subagentExecutor.disposeAll();
			} catch {
				// 清理失败不影响结局
			}
		}

		const endedAt = Date.now();
		const conclusion =
			(result !== null && typeof result === "object" && typeof (result as { conclusion?: unknown }).conclusion === "string"
				? (result as { conclusion: string }).conclusion
				: undefined) ??
			(status === "completed"
				? `工作流完成(${agentsCreated} 个子代理,${reports.length} 条渐进结果,${artifacts.length} 个产物)。`
				: status === "stopped"
					? `工作流被中止(${stopReason ?? "user"})。`
					: `工作流失败:${error ?? "unknown error"}`);

		sink.append({ t: status === "completed" ? "run_completed" : status === "stopped" ? "run_stopped" : "run_errored", result, error, stopReason, ts: endedAt });
		writeMeta(sink, {
			runId,
			slug: start.slug,
			name: start.name,
			status,
			startedAt,
			endedAt,
			args: argValues,
			stopReason,
			error,
			conclusion,
		});

		return {
			runId,
			slug: start.slug,
			name: start.name,
			status,
			result,
			error,
			stopReason,
			reports,
			artifacts,
			phases,
			startedAt,
			endedAt,
			conclusion,
		};
	})();

	const handle: WorkflowRunHandle & { getSummary(): WorkflowRunSummary } = {
		runId,
		get status() {
			return status;
		},
		promise: outcomePromise,
		stop(reason: "user" | "model" = "user") {
			if (status !== "running") return;
			stopReason = reason;
			controller.abort(reason);
			// 让等待中的 ask 立即失败(子代理进程被停掉)。
			void engineOptions.subagentExecutor.disposeAll().catch(() => {});
		},
		getSummary() {
			return {
				runId,
				slug: start.slug,
				name: start.name,
				status,
				startedAt,
				stopReason,
				error: undefined,
				conclusion: undefined,
			};
		},
	};

	runningRuns.set(runId, handle);
	outcomePromise
		.finally(() => {
			runningRuns.delete(runId);
		})
		.catch(() => {
			// outcomePromise 内部不 reject;防御性吞掉
		});

	return handle;
}

// ============================================================================
// 辅助
// ============================================================================

/** 相对路径限制在工作区内(files.read / artifact.file 共用)。 */
function resolveInWorkspace(cwd: string, path: string): string {
	const full = isAbsolute(path) ? path : resolve(cwd, path);
	const rel = relative(cwd, full);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path "${path}" escapes the workspace`);
	}
	return full;
}

function assertArtifactId(id: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		throw new Error(`artifact id "${id}" must match [A-Za-z0-9._-] and start with a letter or digit`);
	}
}

/** 把包装后文件的报错行号换算回脚本行号,便于按 SOP 目录内的源码修复。 */
function adjustScriptError(error: unknown, wrappedPath: string): string {
	const message = error instanceof Error ? `${error.message}` : String(error);
	const stack = error instanceof Error ? error.stack ?? "" : "";
	const lineMatch = new RegExp(`${escapeRegExp(wrappedPath.replace(/\\/g, "\\\\"))}:(\\d+)`).exec(stack);
	if (lineMatch) {
		const scriptLine = Number.parseInt(lineMatch[1], 10) - WRAPPER_PREFIX_LINES;
		if (scriptLine > 0) return `${message} (script line ${scriptLine})`;
	}
	return message;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
