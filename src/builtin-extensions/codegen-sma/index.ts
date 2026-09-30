/**
 * Built-in extension: codegen-sma —— MEA 编排式代码生成流水线。
 *
 * 架构（重构自原提示词注入协议）：循环由代码保证，工作由子进程生成。
 *
 * 双模式运行（同一份代码，按 STAGE_ENV 环境变量区分）：
 * 1. 角色子进程模式（ZHARNESS_CODEGEN_STAGE=<stage id>，由编排器派发的
 *    episode 进程）：`before_agent_start` 整段替换系统提示词为阶段角色
 *    提示词；只读阶段（audit）在 `tool_call` 层拦截写工具。不注册命令、
 *    不注入任何路由协议 —— 保证 episode 上下文干净。
 * 2. 主进程编排模式：注册 `/codegen` 命令，`run` 启动 orchestrator
 *    （见 orchestrator.ts），按固定阶段链派发全新上下文 episode。
 *
 * Skill 目录（知识库素材）解析与安装逻辑保留：
 *   1. ZHARNESS_CODEGEN_SKILL_DIR 环境变量
 *   2. <agentDir>/skills/code-gen-sma（已安装副本）
 *   3. <cwd>/.zharness/skills/code-gen-sma（项目副本）
 *   4. 本模块旁的捆绑 skills/（仓库 / npm / 二进制布局）
 */

import { existsSync, mkdirSync } from "node:fs";
import { copyDirRecursive } from "../../core/skill-install.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir, isBunBinary } from "../../index.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import { runPipeline, type PipelineIO } from "./orchestrator.js";
import { formatStateBrief, loadState } from "./state.js";
import { getStage, STAGE_ENV } from "./stages.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const CODEGEN_SMA_EXTENSION_ID = "codegen-sma";

/** audit 等只读阶段拦截的工具（平台级强制，不依赖提示词自觉） */
const MUTATING_TOOLS = new Set(["write", "edit", "bash", "delegate_agent"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Directory containing the bundled skill family (the parent of code-gen-sma/).
 * - Bun binary: `codegen-sma/skills/` next to the executable (copy-binary-assets)
 * - Node dist / src dev: `skills/` next to this module (copy-assets mirrors it)
 */
function getBundledSkillsRoot(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "codegen-sma", "skills");
	}
	return join(__dirname, "skills");
}

function hasSkillMd(dir: string | undefined): dir is string {
	return !!dir && existsSync(join(dir, "SKILL.md"));
}

/** Locate the code-gen-sma skill directory, or null if not found anywhere. */
export function findCodegenSkillDir(cwd: string = process.cwd()): string | null {
	const candidates: Array<string | undefined> = [
		process.env.ZHARNESS_CODEGEN_SKILL_DIR,
		join(getAgentDir(), "skills", "code-gen-sma"),
		cwd ? join(cwd, ".zharness", "skills", "code-gen-sma") : undefined,
		join(getBundledSkillsRoot(), "code-gen-sma"),
	];
	for (const candidate of candidates) {
		if (hasSkillMd(candidate)) return candidate;
	}
	return null;
}

/** Copy the bundled skill family into `<agentDir>/skills/` for native discovery. */
export function installSkillsToAgentDir(): { ok: boolean; message: string } {
	const bundledRoot = getBundledSkillsRoot();
	if (!existsSync(join(bundledRoot, "code-gen-sma", "SKILL.md"))) {
		return {
			ok: false,
			message:
				`Bundled skills not found at ${bundledRoot}. ` +
				`Set ZHARNESS_CODEGEN_SKILL_DIR to the code-gen-sma skill directory and retry.`,
		};
	}
	const targetRoot = join(getAgentDir(), "skills");
	let installed = 0;
	try {
		mkdirSync(targetRoot, { recursive: true });
		for (const name of [
			"code-gen-sma",
			"interface-test-outline-generator",
			"intf-test-case-generation-from-outline",
			"intf-test-program-generation",
			"intf-testcase-progm-fix",
		]) {
			const source = join(bundledRoot, name);
			if (!existsSync(source)) continue;
			copyDirRecursive(source, join(targetRoot, name));
			installed += 1;
		}
	} catch (error) {
		return {
			ok: false,
			message: `Failed to copy skills to ${targetRoot}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return {
		ok: true,
		message: `Installed ${installed} skill(s) to ${targetRoot}.`,
	};
}

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

// ===== 流水线运行注册表：命令路径(/codegen)与 RPC 路径(GUI 面板)共用 =====
// 防止同一工作区并发跑两条流水线(episode 子进程会互相踩 .codegen/ 状态)。
let codegenAbortRequested = false;
let codegenInFlight: Promise<unknown> | null = null;

/** 是否有流水线正在运行(供 GUI 面板显示运行态)。 */
export function isCodegenRunning(): boolean {
	return codegenInFlight !== null;
}

/** 请求中止当前流水线(协作式:当前 episode 跑完即停,断点保留)。 */
export function requestCodegenAbort(): boolean {
	if (!codegenInFlight) return false;
	codegenAbortRequested = true;
	return true;
}

/**
 * 启动流水线(后台运行,不 await)。已有流水线在跑时拒绝。
 * 返回的 promise 由调用方自行决定是否等待(GUI 不等,命令路径等)。
 */
export function startCodegenPipeline(
	goal: string,
	cwd: string,
	io: PipelineIO,
	resume?: Parameters<typeof runPipeline>[3],
): { ok: boolean; promise: Promise<unknown>; message: string } {
	if (codegenInFlight) {
		return {
			ok: false,
			promise: Promise.resolve(),
			message: "A codegen pipeline is already running. Abort it or wait for completion.",
		};
	}
	codegenAbortRequested = false;
	const run = runPipeline(goal, cwd, io, resume, () => codegenAbortRequested);
	codegenInFlight = run.finally(() => {
		codegenInFlight = null;
		codegenAbortRequested = false;
	});
	void codegenInFlight.catch(() => { /* 失败已通过 io.notify 上报 */ });
	return {
		ok: true,
		promise: codegenInFlight,
		message: resume ? "Pipeline resumed in background." : "Pipeline started in background.",
	};
}

/**
 * 构造编排器 IO。有 UI（交互 TUI / RPC 桥接了对话框的 GUI）时确认点走真实
 * 对话框；无 UI（print 模式 / 未桥接的 RPC 客户端）时自动通过。
 */
function buildPipelineIO(ctx: ExtensionCommandContext): PipelineIO {
	return {
		notify: (message, type) => notify(ctx, message, type),
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : true),
		input: ctx.hasUI ? (title, placeholder) => ctx.ui.input(title, placeholder) : undefined,
	};
}

const USAGE = `Usage:
  /codegen run <task>   Run the MEA-orchestrated pipeline (fresh-context stages)
  /codegen resume       Resume an interrupted/blocked pipeline from its last checkpoint
  /codegen status       Show pipeline state and skill directory resolution
  /codegen install      Copy the bundled skills to <agentDir>/skills/ for native discovery
  /codegen help         Show this help`;

export const createCodegenSmaExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	// ===== 角色子进程模式：由编排器通过 STAGE_ENV 派发的 episode =====
	const stage = getStage(process.env[STAGE_ENV] ?? "");
	if (stage) {
		// 整段替换系统提示词：episode 只看到本阶段角色，上下文干净
		zharness.on("before_agent_start", () => ({ systemPrompt: stage.systemPrompt }));
		// 只读阶段：平台级拦截写工具（比提示词约束/事后监控更硬）
		if (stage.readOnly) {
			zharness.on("tool_call", (event) => {
				if (MUTATING_TOOLS.has(event.toolName)) {
					return { block: true, reason: `「${stage.title}」为只读阶段，禁止修改环境（工具 ${event.toolName} 被拦截）` };
				}
				return undefined;
			});
		}
		return; // 不注册命令、不注入协议
	}

	// ===== 主进程编排模式 =====
	zharness.registerCommand("codegen", {
		description: "MEA-orchestrated coding pipeline with fresh-context stage episodes.",
		async handler(args, ctx) {
			const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();

			switch (subcommand) {
				case "run": {
					const goal = args.trim().slice("run".length).trim();
					if (!goal) {
						notify(ctx, USAGE, "warning");
						return;
					}
					const started = startCodegenPipeline(goal, ctx.cwd, buildPipelineIO(ctx));
					if (!started.ok) {
						notify(ctx, started.message, "warning");
						return;
					}
					await started.promise;
					return;
				}
				case "resume": {
					const state = loadState(ctx.cwd);
					if (!state) {
						notify(ctx, "尚无流水线状态（用 /codegen run <task> 启动）", "warning");
						return;
					}
					if (state.outcome === "completed") {
						notify(ctx, "流水线已完成，无需恢复。如需重做请用 /codegen run <task>", "info");
						return;
					}
					notify(ctx, `恢复流水线：\n${formatStateBrief(state)}`, "info");
					const started = startCodegenPipeline(state.goal, ctx.cwd, buildPipelineIO(ctx), state);
					if (!started.ok) {
						notify(ctx, started.message, "warning");
						return;
					}
					await started.promise;
					return;
				}
				case "status": {
					const state = loadState(ctx.cwd);
					const lines = [
						`Built-in extension: ${CODEGEN_SMA_EXTENSION_ID}`,
						`Skill dir: ${findCodegenSkillDir(ctx.cwd) ?? "NOT FOUND"}`,
						"",
						state ? formatStateBrief(state) : "尚无流水线状态（用 /codegen run <task> 启动）",
					];
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "install": {
					notify(ctx, "Installing code-gen-sma skill family…", "info");
					const result = installSkillsToAgentDir();
					notify(ctx, result.message, result.ok ? "info" : "error");
					if (result.ok) {
						// Reload so the native skill loader picks up the new skills.
						await ctx.reload();
					}
					return;
				}
				case "help":
				default: {
					notify(ctx, USAGE, "info");
					return;
				}
			}
		},
	});
};
