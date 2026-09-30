/**
 * Built-in extensions registry.
 *
 * Built-in extensions ship with ZHarness and are enabled by default. They behave
 * exactly like user extensions (loaded via the same `ExtensionFactory` path)
 * but are always present unless the user explicitly disables one in
 * `settings.json` under `disabledBuiltinExtensions`.
 *
 * To add a new built-in extension:
 * 1. Create a folder under `src/builtin-extensions/<id>/` exporting an `ExtensionFactory`.
 * 2. Register it in `BUILTIN_EXTENSIONS` below with a stable id.
 */

import { existsSync, mkdirSync } from "node:fs";
import { copyDirRecursive } from "../core/skill-install.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "../core/extensions/types.js";
import { getAgentDir, getPackageDir, isBunBinary } from "../index.js";
import {
	AGENT_BROWSER_EXTENSION_ID,
	checkBrowserAvailable,
	createAgentBrowserExtension,
	runAgentBrowserInstall,
	runAgentBrowserUninstall,
} from "./agent-browser/index.js";
import { CODEGEN_SMA_EXTENSION_ID, createCodegenSmaExtension, installSkillsToAgentDir } from "./codegen-sma/index.js";
import {
	CONTEXT_EDITOR_EXTENSION_ID,
	createContextEditorExtension,
} from "./context-editor/index.js";
import {
	KNOWLEDGE_FORGE_EXTENSION_ID,
	createKnowledgeForgeExtension,
} from "./knowledge-forge/index.js";
import {
	PROACTIVE_ASSISTANT_EXTENSION_ID,
	createProactiveAssistantExtension,
} from "./proactive-assistant/index.js";
import { REPLAY_EXTENSION_ID, createReplayExtension, installReplaySkill } from "./replay/index.js";
import { SOP_MARKET_EXTENSION_ID, createSopMarketExtension } from "./sop-market/index.js";
import { TASK_BOARD_EXTENSION_ID, createTaskBoardExtension } from "./task-board/index.js";

/** Result of an install/uninstall lifecycle action. */
export interface ExtensionLifecycleResult {
	ok: boolean;
	message: string;
}

/** Result of checking whether an extension's external dependency is installed. */
export interface ExtensionInstallState {
	installed: boolean;
	version?: string;
}

export interface BuiltinExtension {
	/** Stable id used in `settings.disabledBuiltinExtensions`. */
	id: string;
	/** Human-readable name shown in UI. Defaults to the id. */
	name: string;
	/** Short, human-readable description shown in UI. */
	description: string;
	/** Factory that registers tools, commands, and event handlers. */
	factory: ExtensionFactory;
	/** Whether this built-in ships an external dependency that can be installed/uninstalled (e.g. a CLI binary). */
	installable?: boolean;
	/** Check whether the external dependency is installed. Only when installable. */
	checkInstalled?: (cwd: string) => Promise<ExtensionInstallState>;
	/** Install the external dependency. Only when installable. */
	install?: (cwd: string) => Promise<ExtensionLifecycleResult>;
	/** Uninstall the external dependency. Only when installable. */
	uninstall?: (cwd: string) => Promise<ExtensionLifecycleResult>;
}

/**
 * All built-in extensions, in load order. Load order matters for command/tool
 * conflict precedence (earlier wins for diagnostics; both are kept).
 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
	{
		id: AGENT_BROWSER_EXTENSION_ID,
		name: "agent-browser",
		description: "Browser automation CLI for AI agents (Chrome/Chromium via CDP).",
		factory: createAgentBrowserExtension,
		installable: true,
		checkInstalled: (cwd) => checkBrowserAvailable(cwd),
		install: (cwd) => runAgentBrowserInstall(cwd),
		uninstall: (cwd) => runAgentBrowserUninstall(cwd),
	},
	{
		id: CODEGEN_SMA_EXTENSION_ID,
		name: "codegen-sma",
		description:
			"MEA-orchestrated coding pipeline: fresh-context stage episodes, deterministic gates, and compliance checkpoints.",
		factory: createCodegenSmaExtension,
	},
	{
		id: REPLAY_EXTENSION_ID,
		name: "replay",
		description:
			"Task replay: replay-summary skill (schema 2.0) + read-only replay directory for the GUI replay page.",
		factory: createReplayExtension,
	},
	{
		id: TASK_BOARD_EXTENSION_ID,
		name: "task-board",
		description:
			"任务看板：工作区级持久化任务卡（task_board agent 工具 + /taskboard 命令 + GUI 首页看板 RPC）。",
		factory: createTaskBoardExtension,
	},
	{
		id: CONTEXT_EDITOR_EXTENSION_ID,
		name: "context-editor",
		description:
			"上下文编辑器：发送消息前查看并编辑真正的 LLM 上下文（系统提示词 / 工具列表 / 投影消息），" +
			"按类型着色，并明确标注每次编辑是仅下一次生效还是持续生效（GUI Composer 入口）。",
		factory: createContextEditorExtension,
	},
	{
		id: PROACTIVE_ASSISTANT_EXTENSION_ID,
		name: "proactive-assistant",
		description:
			"主动式交互助手：后台实时分析当前对话，阻塞时主动给出脱困建议，做得好时提示沉淀本次经验" +
			"为长期知识（GUI 右下角浮动小助手 + /assistant 命令）。",
		factory: createProactiveAssistantExtension,
	},
	{
		id: KNOWLEDGE_FORGE_EXTENSION_ID,
		name: "knowledge-forge",
		description:
			"知识与技能沉淀：启用后每晚凌晨自动扫描回看窗口内（默认 1 天，可选一周/一月）的会话与上传附件，" +
			"由大模型分析提炼有价值的知识与技能，按类目沉淀到本地库（可选全局目录或项目目录；" +
			"/knowledge 命令 + knowledge_scan / knowledge_save 工具）。",
		factory: createKnowledgeForgeExtension,
	},
	{
		id: SOP_MARKET_EXTENSION_ID,
		name: "sop-market",
		description:
			"SOP 市场：安装到 <agentDir>/sops/ 的工作流模板。声明式（steps + 并行组）" +
			"渲染成编排提示词交给会话执行；动态工作流（kind: dynamic + workflow.ts 脚本）" +
			"由引擎编排子代理进程后台运行（/sop run|runs|stop）。市场目录与安装走 RPC（GUI 配置页）。",
		factory: createSopMarketExtension,
	},
];

/**
 * Return the built-in extensions (id + factory), excluding any disabled ids.
 */
export function getBuiltinExtensionFactories(
	disabledIds: ReadonlySet<string>,
): BuiltinExtension[] {
	return BUILTIN_EXTENSIONS.filter((ext) => !disabledIds.has(ext.id));
}

/** Lightweight info about every built-in extension (no factory), for UI / RPC. */
export interface BuiltinExtensionInfo {
	id: string;
	name: string;
	description: string;
}

/** All built-in extension ids (for diagnostics / UI). */
export function getBuiltinExtensionIds(): string[] {
	return BUILTIN_EXTENSIONS.map((ext) => ext.id);
}

/** Info (id/name/description) for every built-in extension, regardless of enabled state. */
export function getBuiltinExtensionInfos(): BuiltinExtensionInfo[] {
	return BUILTIN_EXTENSIONS.map((ext) => ({ id: ext.id, name: ext.name, description: ext.description }));
}

/** Look up info for a single built-in extension id. */
export function getBuiltinExtensionInfo(id: string): BuiltinExtensionInfo | undefined {
	return BUILTIN_EXTENSIONS.find((ext) => ext.id === id);
}


/** Look up the install lifecycle (install/uninstall/checkInstalled) for a built-in id. */
export function getBuiltinExtensionLifecycle(
	id: string,
): Pick<BuiltinExtension, "installable" | "checkInstalled" | "install" | "uninstall"> | undefined {
	const ext = BUILTIN_EXTENSIONS.find((e) => e.id === id);
	if (!ext) return undefined;
	return {
		installable: ext.installable,
		checkInstalled: ext.checkInstalled,
		install: ext.install,
		uninstall: ext.uninstall,
	};
}

/**
 * Preinstall the bundled skill families (codegen-sma + replay-summary +
 * zharness-self-optimization + api-map) into `<agentDir>/skills/`. Idempotent: a skill
 * whose target already exists is skipped so local user modifications are never
 * overwritten. Called once at rpc-mode startup, BEFORE the facade is created
 * (skills are loaded into the system prompt at session start), so packaged
 * users no longer need to run `/codegen install` / `/replay install` by hand.
 * Failures are non-fatal — the manual install commands remain available.
 */
export function ensureBundledSkillsInstalled(): void {
	const agentSkillsRoot = join(getAgentDir(), "skills");
	try {
		if (!existsSync(join(agentSkillsRoot, "code-gen-sma", "SKILL.md"))) {
			installSkillsToAgentDir();
		}
	} catch { /* non-fatal */ }
	try {
		if (!existsSync(join(agentSkillsRoot, "replay-summary", "SKILL.md"))) {
			installReplaySkill();
		}
	} catch { /* non-fatal */ }
	try {
		if (!existsSync(join(agentSkillsRoot, "zharness-self-optimization", "SKILL.md"))) {
			installBuiltinSkill("zharness-self-optimization");
		}
	} catch { /* non-fatal */ }
	try {
		if (!existsSync(join(agentSkillsRoot, "api-map", "SKILL.md"))) {
			installBuiltinSkill("api-map");
		}
	} catch { /* non-fatal */ }
}

/**
 * Directory containing the built-in skill family (the parent of <id>/).
 * - Bun binary: `builtin-skills/` next to the executable (copy-binary-assets)
 * - Node dist / src dev: `builtin-skills/` sibling of builtin-extensions
 */
function getBuiltinSkillsRoot(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "builtin-skills");
	}
	// src/builtin-extensions → src/builtin-skills(dist 同构:dist/src/…)
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "builtin-skills");
}

/** Copy one built-in skill directory into `<agentDir>/skills/`. */
function installBuiltinSkill(id: string): void {
	const source = join(getBuiltinSkillsRoot(), id);
	if (!existsSync(join(source, "SKILL.md"))) return;
	const targetRoot = join(getAgentDir(), "skills");
	mkdirSync(targetRoot, { recursive: true });
	copyDirRecursive(source, join(targetRoot, id));
}
