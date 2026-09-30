/**
 * Built-in extension: sop-market —— SOP 市场(工作流模板的分发与运行)。
 *
 * SOP 是安装到 <agentDir>/sops/<slug>/SOP.md 的可分发工作流定义,市场
 * 目录与安装走 RPC(sop_list / sop_market / sop_install / sop_uninstall,
 * GUI「专家·技能·连接器·SOP 市场」页)。本扩展负责会话内的 `/sop` 命令:
 *
 *   /sop                     列出已安装的 SOP
 *   /sop run <slug> [k=v…]   运行一个 SOP(static:渲染提示词交当前会话执行;
 *                             dynamic:启动动态工作流运行,后台编排子代理)
 *   /sop runs                列出动态工作流运行记录(进行中/历史)
 *   /sop stop <runId>        中止一个进行中的动态工作流
 *   /sop show <slug>         查看某个 SOP 的定义(步骤表或脚本概要)
 *   /sop help                帮助
 *
 * static 的实现:renderSopWorkflowPrompt 把定义展开成编排提示词,经
 * zharness.sendUserMessage 触发一个新回合,模型按步骤推进。
 * dynamic 的实现:core/workflow 引擎执行 workflow.ts 脚本,agent().ask()
 * 派生独立子代理进程(RpcClient),进度经状态行汇报,结束时把结论、渐进
 * 结果与产物以会话消息交付 —— 模型对齐 ZCode 的 CreateWorkflow。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.js";
import { getAgentDir } from "../../config.js";
import { findInstalledSop, loadInstalledSops, parseRunArgs, renderSopWorkflowPrompt, type Sop } from "../../core/sop.js";
import {
	createRpcSubagentExecutor,
	listWorkflowRuns,
	startWorkflowRun,
	stopWorkflowRun,
	validateWorkflowArgs,
	type WorkflowRunOutcome,
} from "../../core/workflow/index.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const SOP_MARKET_EXTENSION_ID = "sop-market";

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

const USAGE = `Usage:
  /sop                          列出已安装的 SOP
  /sop run <slug> [k=v …]       运行一个 SOP 工作流(参数按 key=value 传)
  /sop runs                     列出动态工作流运行记录
  /sop stop <runId>             中止一个进行中的动态工作流
  /sop show <slug>              查看 SOP 的定义
  /sop help                     本帮助

从「专家·技能·连接器·SOP 市场」页安装更多工作流模板。`;

function listInstalled(ctx: ExtensionCommandContext): void {
	const { sops } = loadInstalledSops();
	if (sops.length === 0) {
		notify(ctx, "尚无已安装的 SOP。到「SOP 市场」页安装,或把 SOP.md 放进 <agentDir>/sops/<slug>/。", "warning");
		return;
	}
	const lines = sops.map((s) => {
		const kind = s.kind === "dynamic" ? "动态" : `${s.steps.length} 步`;
		const args = s.args.length ? `, 参数: ${s.args.map((a) => a.name).join(", ")}` : "";
		return `  ${s.slug} [${s.kind === "dynamic" ? "动态工作流" : "声明式"}] — ${s.description}（${kind}${args}）`;
	});
	notify(ctx, `已安装的 SOP(${sops.length} 个):\n${lines.join("\n")}\n\n运行:/sop run <slug> [k=v …]`);
}

function showSop(ctx: ExtensionCommandContext, slug: string): void {
	const sop = findInstalledSop(slug);
	if (!sop) {
		notify(ctx, `SOP "${slug}" 未安装。用 /sop 查看已安装列表。`, "error");
		return;
	}
	if (sop.kind === "dynamic") {
		const args = sop.args.length
			? sop.args.map((a) => `  ${a.name}${a.required ? "(必填)" : ""}${a.description ? ` — ${a.description}` : ""}`).join("\n")
			: "  （无）";
		const scriptLines = (sop.scriptSource ?? "").split("\n").length;
		notify(
			ctx,
			[
				`${sop.slug} [动态工作流] — ${sop.description}`,
				`脚本:${sop.scriptPath ?? "workflow.ts"}(${scriptLines} 行,经 jiti 转译执行)`,
				`并发上限:${sop.concurrency ?? "默认(4)"}`,
				"参数:",
				args,
				"",
				"脚本以 agent()/ask()/phase()/log()/report()/world.run()/artifact()/args 编排子代理。",
				`运行:/sop run ${sop.slug} k=v …(后台运行,/sop runs 查看进度)`,
			].join("\n"),
		);
		return;
	}
	const steps = sop.steps
		.map((s, i) => `  ${i + 1}. ${s.title ?? s.id}${s.role ? `（${s.role}）` : ""}${s.parallel ? " [并行组]" : ""}`)
		.join("\n");
	const args = sop.args.length
		? sop.args.map((a) => `  ${a.name}${a.required ? "(必填)" : ""}${a.description ? ` — ${a.description}` : ""}`).join("\n")
		: "  （无）";
	notify(
		ctx,
		`${sop.slug} [声明式] — ${sop.description}\n步骤:\n${steps}\n参数:\n${args}\n\n运行:/sop run ${sop.slug} k=v …`,
	);
}

function formatRunLine(run: { runId: string; slug: string; status: string; startedAt: number; conclusion?: string; error?: string }): string {
	const started = new Date(run.startedAt).toLocaleString();
	const statusLabel =
		run.status === "running" ? "运行中" : run.status === "completed" ? "已完成" : run.status === "stopped" ? "已中止" : "失败";
	const tail = run.conclusion ? ` — ${run.conclusion.slice(0, 60)}` : run.error ? ` — ${run.error.slice(0, 60)}` : "";
	return `  ${run.runId.slice(0, 13)}… ${run.slug} [${statusLabel}] ${started}${tail}`;
}

function listRuns(ctx: ExtensionCommandContext): void {
	const runs = listWorkflowRuns();
	if (runs.length === 0) {
		notify(ctx, "暂无动态工作流运行记录。用 /sop run <dynamic-slug> 启动一个。", "warning");
		return;
	}
	notify(
		ctx,
		`动态工作流运行(${runs.length} 条,新→旧):\n${runs.map(formatRunLine).join("\n")}\n\n中止:/sop stop <runId>`,
	);
}

/** 把运行结局渲染成随通知交付的 markdown(渐进结果与产物一并带上)。 */
export function formatRunOutcome(outcome: WorkflowRunOutcome): string {
	const lines: string[] = [];
	const statusLabel =
		outcome.status === "completed" ? "✅ 完成" : outcome.status === "stopped" ? "⏹ 已中止" : "❌ 失败";
	lines.push(`### 动态工作流 ${outcome.name} — ${statusLabel}`);
	lines.push("");
	lines.push(outcome.conclusion);
	if (outcome.error) {
		lines.push("");
		lines.push(`失败原因:${outcome.error}`);
	}
	if (outcome.phases.length > 0) {
		lines.push("");
		lines.push(`阶段:${outcome.phases.join(" → ")}`);
	}
	if (outcome.artifacts.length > 0) {
		lines.push("");
		lines.push("产物:");
		for (const artifact of outcome.artifacts) {
			const flag = artifact.primary ? "(主交付物)" : "";
			lines.push(`- ${artifact.title ?? artifact.id}: \`${artifact.path}\` ${flag}`);
		}
	}
	if (outcome.reports.length > 0) {
		lines.push("");
		lines.push(`渐进结果(${outcome.reports.length} 条):`);
		for (const report of outcome.reports.slice(0, 20)) {
			const text = typeof report.item === "string" ? report.item : JSON.stringify(report.item);
			lines.push(`- ${text.slice(0, 200)}`);
		}
		if (outcome.reports.length > 20) lines.push(`- …(共 ${outcome.reports.length} 条,见 journal)`);
	}
	lines.push("");
	lines.push(`运行记录:<agentDir>/sop-runs/${outcome.runId}/`);
	return lines.join("\n");
}

/** 启动一个动态工作流运行(后台推进;结束时向会话交付结局消息)。 */
async function runDynamicSop(
	zharness: ExtensionAPI,
	ctx: ExtensionCommandContext,
	sop: Sop,
	runArgs: Record<string, string>,
): Promise<void> {
	const { values, errors } = validateWorkflowArgs(sop.args, runArgs);
	if (errors.length > 0) {
		notify(ctx, `参数不完整:\n${errors.map((e) => `  - ${e}`).join("\n")}`, "error");
		return;
	}
	const subagentExecutor = createRpcSubagentExecutor({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
	});
	const started = new Date();
	let handle;
	try {
		handle = await startWorkflowRun(
			{
				slug: sop.slug,
				name: sop.name,
				scriptSource: sop.scriptSource ?? "",
				args: values,
				argDefs: sop.args,
				concurrency: sop.concurrency,
			},
			{
				subagentExecutor,
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				onEvent: (event) => {
					if (!ctx.hasUI) return;
					if (event.type === "phase") {
						ctx.ui.setStatus("sop-run", `⚙ ${sop.name}:${event.name}`);
					} else if (event.type === "ask_started") {
						ctx.ui.setStatus("sop-run", `⚙ ${sop.name}:${event.actorName} 执行中`);
					}
				},
			},
		);
	} catch (error) {
		notify(ctx, `启动失败:${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const runId = handle.runId;
	const finish = (outcome: WorkflowRunOutcome): void => {
		if (ctx.hasUI) ctx.ui.setStatus("sop-run", undefined);
		const elapsed = Math.round((outcome.endedAt - started.getTime()) / 1000);
		// 结局以会话消息交付(不触发新回合):TUI/GUI 都能在对话里看到,
		// 下一个真实回合的模型也能读到这份结果。
		zharness.sendMessage(
			{
				customType: "sop_run_result",
				content: `${formatRunOutcome(outcome)}\n(耗时 ${elapsed}s)`,
				display: true,
				details: { runId: outcome.runId, slug: outcome.slug, status: outcome.status },
			},
			{ triggerTurn: false },
		);
		if (!ctx.hasUI) console.log(formatRunOutcome(outcome));
	};

	if (ctx.hasUI) {
		notify(
			ctx,
			`动态工作流「${sop.name}」已启动(run ${runId.slice(0, 13)}…)。状态行实时汇报进度;\n/sop runs 查看记录,/sop stop ${runId.slice(0, 13)} 中止;结束时结果会出现在对话里。`,
		);
		void handle.promise.then(finish, (error: unknown) =>
			finish({
				runId,
				slug: sop.slug,
				name: sop.name,
				status: "errored",
				error: error instanceof Error ? error.message : String(error),
				reports: [],
				artifacts: [],
				phases: [],
				startedAt: started.getTime(),
				endedAt: Date.now(),
				conclusion: `工作流异常:${error instanceof Error ? error.message : String(error)}`,
			}),
		);
		return;
	}

	// 无 UI(print/RPC):同步等待结局并打印。
	const outcome = await handle.promise;
	finish(outcome);
}

export const createSopMarketExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	zharness.registerCommand("sop", {
		description: "SOP market: run installed SOP workflows (list / run / runs / stop / show).",
		async handler(args, ctx) {
			const trimmed = args.trim();
			const subcommand = (trimmed.split(/\s+/)[0] || "list").toLowerCase();
			const rest = trimmed.slice(subcommand.length).trim();

			switch (subcommand) {
				case "run": {
					const { name, args: runArgs } = parseRunArgs(rest);
					if (!name) {
						notify(ctx, "用法:/sop run <slug> [k=v …]", "warning");
						return;
					}
					const sop = findInstalledSop(name);
					if (!sop) {
						notify(ctx, `SOP "${name}" 未安装。用 /sop 查看已安装列表。`, "error");
						return;
					}
					if (sop.kind === "dynamic") {
						await runDynamicSop(zharness, ctx, sop, runArgs);
						return;
					}
					const prompt = renderSopWorkflowPrompt(sop, runArgs);
					// sendUserMessage 必定触发一个新回合:命令本身被 tryExtensionCommand
					// 消费(不再进模型),工作流的编排提示词以用户消息形式进入会话。
					zharness.sendUserMessage(prompt);
					return;
				}
				case "runs": {
					listRuns(ctx);
					return;
				}
				case "stop": {
					if (!rest) {
						notify(ctx, "用法:/sop stop <runId>(runId 见 /sop runs,前缀即可)", "warning");
						return;
					}
					const runs = listWorkflowRuns().filter((r) => r.runId.startsWith(`run-${rest.replace(/^run-/, "")}`));
					if (runs.length === 0) {
						notify(ctx, `没有匹配 "${rest}" 的运行记录。`, "error");
						return;
					}
					const target = runs[0];
					if (target.status !== "running") {
						notify(ctx, `运行 ${target.runId.slice(0, 13)}… 已结束(${target.status}),无需中止。`, "warning");
						return;
					}
					if (stopWorkflowRun(target.runId, "user")) {
						notify(ctx, `已请求中止运行 ${target.runId.slice(0, 13)}…(子代理进程将被回收)`);
					} else {
						notify(ctx, `未能中止 ${target.runId.slice(0, 13)}…(可能在别的进程里启动)`, "warning");
					}
					return;
				}
				case "show": {
					if (!rest) {
						notify(ctx, "用法:/sop show <slug>", "warning");
						return;
					}
					showSop(ctx, rest.split(/\s+/)[0]);
					return;
				}
				case "list":
					listInstalled(ctx);
					return;
				case "help":
				default:
					notify(ctx, USAGE);
					return;
			}
		},
	});
};
