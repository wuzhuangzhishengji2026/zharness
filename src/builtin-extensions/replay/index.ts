/**
 * Built-in extension: replay —— 研发任务回放（移植自 DSH dsh-replay2 插件）。
 *
 * 两件事：
 * 1. 捆绑 replay-summary skill（schema 2.0 回放摘要生成），`/replay install`
 *    复制到 <agentDir>/skills/ 供原生 skill 加载器发现（与 codegen-sma 同模式）。
 * 2. `/replay dir|status` 暴露当前会话的回放目录：
 *      <agentDir>/workspaces/<workspace_id>/replay/<sessionId>/
 *    摘要（replay-summary.json + artifacts/）由 skill 写入该目录；
 *    GUI「回放」页通过 RPC 只读命令（get_replay_summary / list_replay_dir /
 *    read_replay_file）播放。
 *
 * Skill 目录解析顺序：
 *   1. ZHARNESS_REPLAY_SKILL_DIR 环境变量
 *   2. <agentDir>/skills/replay-summary（已安装副本）
 *   3. <cwd>/.zharness/skills/replay-summary（项目副本）
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
import { getReplaySessionDir } from "../../core/replay/index.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const REPLAY_EXTENSION_ID = "replay";

const SKILL_NAME = "replay-summary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Directory containing the bundled skill (the parent of replay-summary/).
 * - Bun binary: `replay/skills/` next to the executable (copy-binary-assets)
 * - Node dist / src dev: `skills/` next to this module (copy-assets mirrors it)
 */
function getBundledSkillsRoot(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "replay", "skills");
	}
	return join(__dirname, "skills");
}

function hasSkillMd(dir: string | undefined): dir is string {
	return !!dir && existsSync(join(dir, "SKILL.md"));
}

/** Locate the replay-summary skill directory, or null if not found anywhere. */
export function findReplaySkillDir(cwd: string = process.cwd()): string | null {
	const candidates: Array<string | undefined> = [
		process.env.ZHARNESS_REPLAY_SKILL_DIR,
		join(getAgentDir(), "skills", SKILL_NAME),
		cwd ? join(cwd, ".zharness", "skills", SKILL_NAME) : undefined,
		join(getBundledSkillsRoot(), SKILL_NAME),
	];
	for (const candidate of candidates) {
		if (hasSkillMd(candidate)) return candidate;
	}
	return null;
}

/** Copy the bundled skill into `<agentDir>/skills/` for native discovery. */
export function installReplaySkill(): { ok: boolean; message: string } {
	const source = join(getBundledSkillsRoot(), SKILL_NAME);
	if (!hasSkillMd(source)) {
		return {
			ok: false,
			message:
				`Bundled skill not found at ${source}. ` +
				`Set ZHARNESS_REPLAY_SKILL_DIR to the replay-summary skill directory and retry.`,
		};
	}
	const targetRoot = join(getAgentDir(), "skills");
	try {
		mkdirSync(targetRoot, { recursive: true });
		copyDirRecursive(source, join(targetRoot, SKILL_NAME));
	} catch (error) {
		return {
			ok: false,
			message: `Failed to copy skill to ${targetRoot}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, message: `Installed ${SKILL_NAME} to ${join(targetRoot, SKILL_NAME)}.` };
}

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

/** Current session id + workspace id, when the session view is event-backed. */
function currentSessionInfo(ctx: ExtensionCommandContext): { sessionId: string; workspaceId: string } | null {
	const sm = ctx.sessionManager;
	const sessionId = sm.projection?.getDescriptor().session_id;
	const workspaceId = sm.eventStore?.workspace_id;
	if (!sessionId || !workspaceId) return null;
	return { sessionId, workspaceId };
}

const USAGE = `Usage:
  /replay install    Install the bundled replay-summary skill to <agentDir>/skills/
  /replay dir        Show (and create) the current session's replay directory
  /replay status     Show skill dir resolution and the current replay directory
  /replay help       Show this help

生成回放摘要：安装 skill 后，对 agent 说「生成回放摘要」（或调用 /skill:${SKILL_NAME}），
然后在 GUI 左侧「回放」页播放。`;

export const createReplayExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	zharness.registerCommand("replay", {
		description: "Task replay: install the replay-summary skill and locate replay directories.",
		async handler(args, ctx) {
			const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();

			switch (subcommand) {
				case "install": {
					notify(ctx, "Installing replay-summary skill…", "info");
					const result = installReplaySkill();
					notify(ctx, result.message, result.ok ? "info" : "error");
					if (result.ok) {
						// Reload so the native skill loader picks up the new skill.
						await ctx.reload();
					}
					return;
				}
				case "dir": {
					const info = currentSessionInfo(ctx);
					if (!info) {
						notify(ctx, "当前会话不是事件库会话，无法定位回放目录", "warning");
						return;
					}
					const dir = getReplaySessionDir(info.workspaceId, info.sessionId);
					mkdirSync(dir, { recursive: true });
					notify(ctx, `回放目录（replay-summary.json 与 artifacts/ 放这里）：\n${dir}`, "info");
					return;
				}
				case "status": {
					const info = currentSessionInfo(ctx);
					const lines = [
						`Built-in extension: ${REPLAY_EXTENSION_ID}`,
						`Skill dir: ${findReplaySkillDir(ctx.cwd) ?? "NOT FOUND（先运行 /replay install）"}`,
					];
					if (info) {
						const dir = getReplaySessionDir(info.workspaceId, info.sessionId);
						lines.push(`Session: ${info.sessionId}`);
						lines.push(`Replay dir: ${dir}${existsSync(join(dir, "replay-summary.json")) ? "（已有 replay-summary.json）" : "（尚无摘要）"}`);
					}
					notify(ctx, lines.join("\n"), "info");
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
