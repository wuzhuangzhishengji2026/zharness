/**
 * Built-in extension: knowledge-forge —— 知识与技能沉淀。
 *
 * 启用后自动创建两个每日凌晨的定时任务（知识沉淀 / 技能沉淀）。任务触发
 * 时调度器把分析 prompt 派发进新会话，由主模型驱动两个插件工具完成闭环：
 *   - knowledge_scan：回看可配置时间窗（默认 1 天，可选一周/一月）内的
 *     会话与上传附件，压缩成分析材料；
 *   - knowledge_save：把模型提炼出的知识/技能按类目写入本地沉淀库
 *     （全局目录或项目目录，可配置）。
 *
 * 交互入口：/knowledge 命令（status / config / run / library / enable /
 * disable），与 GUI 插件页共用 BuiltinExtensions 注册信息。
 *
 * Enable/disable state is persisted in `settings.json` under
 * `disabledBuiltinExtensions`（同 proactive-assistant 模式）。
 */

import { getAgentDir, SettingsManager } from "../../index.js";
import { Type } from "@sinclair/typebox";
import {
	loadConfig,
	saveGlobalConfig,
	windowLabel,
	windowMs,
	type KnowledgeForgeConfig,
	type ScanWindow,
} from "./config.js";
import {
	libraryStats,
	resolveLibraryRoot,
	saveEntry,
	type EntryKind,
} from "./library.js";
import { renderScanResult, scanSessions } from "./scan.js";
import {
	buildDigestPrompt,
	ensureScheduledTasks,
	findKnowledgeForgeTasks,
	removeScheduledTasks,
	type DigestPurpose,
} from "./tasks.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import { deriveWorkspaceId } from "../../core/event-store/workspace.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const KNOWLEDGE_FORGE_EXTENSION_ID = "knowledge-forge";

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

function persistDisabled(cwd: string, disabled: boolean): void {
	const settings = SettingsManager.create(cwd, getAgentDir());
	settings.setBuiltinExtensionDisabled(KNOWLEDGE_FORGE_EXTENSION_ID, disabled);
}

/** 当前 sidecar 的工作区 id（项目模式下任务建在本工作区 scope）。 */
function resolveWorkspaceId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.eventStore?.workspace_id ?? deriveWorkspaceId(ctx.cwd);
}

/** 启用即建任务：幂等，失败只警告不影响主流程。 */
function ensureTasksForContext(ctx: ExtensionContext, config: KnowledgeForgeConfig): void {
	try {
		const isProject = config.destination === "project";
		const workspaceId = resolveWorkspaceId(ctx);
		// 全局库 → 任务建在 main scope（主 sidecar 引擎接管）；
		// 项目库 → 建在当前工作区 scope（该项目窗口的 sidecar 引擎接管）。
		ensureScheduledTasks({
			scope: isProject ? "workspace" : "main",
			workspaceId: isProject ? workspaceId : undefined,
			config,
		});
	} catch (e) {
		console.warn(
			`[knowledge-forge] ensure scheduled tasks failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

const USAGE = `Usage:
  /knowledge status                          查看配置/任务/沉淀库状态
  /knowledge config window day|week|month    回看窗口（默认 day）
  /knowledge config dest global|project      沉淀库位置（全局目录/项目目录）
  /knowledge config hours <知识时> <技能时>   每日触发小时（0-23，默认 2 3）
  /knowledge run knowledge|skill             立即在当前会话执行一次沉淀
  /knowledge library                         查看沉淀库统计与最近条目
  /knowledge disable                         禁用本内置扩展并移除定时任务
  /knowledge enable                          重新启用（重建定时任务）
  /knowledge help                            显示本帮助

每晚凌晨自动扫描回看窗口内的会话，把有价值的知识与技能沉淀到本地库。`;

export const createKnowledgeForgeExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	// ------------------------------------------------------------------
	// 启用即建任务：session_start 保证拿到了带 cwd/workspace 的 ctx
	// ------------------------------------------------------------------
	zharness.on("session_start", (_event, ctx) => {
		const config = loadConfig({ projectDir: ctx.cwd });
		ensureTasksForContext(ctx, config);
	});

	// ------------------------------------------------------------------
	// Agent 工具：扫描 + 沉淀（定时任务与手动 /knowledge run 共用）
	// ------------------------------------------------------------------
	zharness.registerTool({
		name: "knowledge_scan",
		label: "Knowledge Scan",
		description:
			"扫描回看时间窗内的历史会话（含上传附件的元信息），返回压缩后的分析材料。" +
			'kind="knowledge" 侧重事实结论与决策，kind="skill" 侧重操作方法与流程。' +
			"用于知识与技能沉淀任务（knowledge-forge），也可在用户要求复盘/总结近期工作时调用。",
		promptSnippet: "knowledge_scan: scan recent sessions for knowledge/skill distillation",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("knowledge"), Type.Literal("skill")], {
				description: "材料用途：knowledge=知识沉淀，skill=技能沉淀",
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const config = loadConfig({ projectDir: ctx.cwd });
			const result = scanSessions({
				windowMs: windowMs(config.window),
				// 项目库只扫本工作区；全局库扫全部工作区。
				workspaceIds:
					config.destination === "project" && resolveWorkspaceId(ctx)
						? [resolveWorkspaceId(ctx)!]
						: undefined,
			});
			const text = renderScanResult(result, windowLabel(config.window));
			return {
				content: [
					{
						type: "text",
						text:
							result.conversations.length === 0
								? text
								: `${text}\n（材料完。请基于以上内容执行沉淀分析。）`,
					},
				],
				details: { conversations: result.conversations.length, truncated: result.truncated },
			};
		},
	});

	zharness.registerTool({
		name: "knowledge_save",
		label: "Knowledge Save",
		description:
			"把一条提炼好的知识/技能写入本地沉淀库（带类目与 frontmatter，重复条目自动去重）。" +
			"content 必须自包含、脱离原会话可直接复用。",
		promptSnippet: "knowledge_save: persist one distilled knowledge/skill entry to the local library",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("knowledge"), Type.Literal("skill")], {
				description: "条目类型：knowledge=知识，skill=技能",
			}),
			category: Type.String({ description: "类目，如「环境与构建」「调试技巧」「工作流」" }),
			title: Type.String({ description: "条目标题（一句话，同名去重）" }),
			content: Type.String({ description: "正文：自包含、可直接复用的知识或可执行的步骤/命令" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签（可选）" })),
			source_sessions: Type.Optional(
				Type.Array(Type.String(), { description: "来源会话 id（可选，溯源用）" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const config = loadConfig({ projectDir: ctx.cwd });
			const root = resolveLibraryRoot({
				destination: config.destination,
				projectDir: ctx.cwd,
			});
			const result = saveEntry(
				{
					kind: params.kind as EntryKind,
					category: params.category,
					title: params.title,
					content: params.content,
					tags: params.tags,
					sourceSessions: params.source_sessions,
				},
				root,
			);
			const text =
				result.status === "saved"
					? `已沉淀（${params.kind === "knowledge" ? "知识" : "技能"} · ${params.category}）：${params.title}\n路径: ${result.path}`
					: result.status === "duplicate"
						? `库中已存在同名条目，跳过：${params.title}\n路径: ${result.path}`
						: `保存失败：${result.error}`;
			return {
				content: [{ type: "text", text }],
				details: { ...result },
			};
		},
	});

	// ------------------------------------------------------------------
	// 斜杠命令：人工入口
	// ------------------------------------------------------------------
	zharness.registerCommand("knowledge", {
		description: "知识与技能沉淀：查看/配置 nightly 扫描沉淀任务，或立即执行一次。",
		getArgumentCompletions: (argumentPrefix) => {
			const subs = ["status", "config", "run", "library", "disable", "enable", "help"];
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			if (argumentPrefix.includes(" ")) return null;
			return subs.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/);
			const subcommand = (parts[0] || "help").toLowerCase();

			switch (subcommand) {
				case "status": {
					const config = loadConfig({ projectDir: ctx.cwd });
					const tasks = findKnowledgeForgeTasks();
					const root = resolveLibraryRoot({ destination: config.destination, projectDir: ctx.cwd });
					const stats = libraryStats(root);
					const lines = [
						`knowledge-forge 状态：`,
						`  回看窗口: ${windowLabel(config.window)} · 库位置: ${
							config.destination === "global" ? "全局" : "项目"
						}（${root}）`,
						`  每日触发: 知识 ${String(config.knowledgeHour).padStart(2, "0")}:${String(20).padStart(2, "0")} · 技能 ${String(config.skillHour).padStart(2, "0")}:${String(50).padStart(2, "0")}`,
						`  定时任务: ${tasks.length}/2（${tasks.map((t) => `${t.name} ${t.enabled ? "启用" : "停用"}`).join("；") || "未创建"}）`,
						`  沉淀库: 知识 ${stats.knowledge.entries} 条/${stats.knowledge.categories} 类 · 技能 ${stats.skills.entries} 条/${stats.skills.categories} 类`,
					];
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "config": {
					const key = (parts[1] ?? "").toLowerCase();
					const value = parts[2];
					const config = loadConfig({ projectDir: ctx.cwd });
					if (key === "window" && (value === "day" || value === "week" || value === "month")) {
						saveGlobalConfig({ ...config, window: value as ScanWindow });
					} else if (key === "dest" && (value === "global" || value === "project")) {
						saveGlobalConfig({ ...config, destination: value });
					} else if (key === "hours" && parts.length >= 4) {
						const k = Number.parseInt(parts[2]!, 10);
						const s = Number.parseInt(parts[3]!, 10);
						if (Number.isFinite(k) && Number.isFinite(s) && k >= 0 && k <= 23 && s >= 0 && s <= 23) {
							saveGlobalConfig({ ...config, knowledgeHour: k, skillHour: s });
						} else {
							notify(ctx, "用法: /knowledge config hours <知识时> <技能时>（0-23）", "warning");
							return;
						}
					} else {
						notify(
							ctx,
							"用法: /knowledge config window day|week|month | dest global|project | hours <0-23> <0-23>",
							"warning",
						);
						return;
					}
					// 配置变更后重建任务（触发时间/prompt 随配置更新）。
					const next = loadConfig({ projectDir: ctx.cwd });
					ensureTasksForContext(ctx, next);
					notify(ctx, `配置已更新：窗口 ${windowLabel(next.window)} · 库 ${next.destination} · 触发 ${next.knowledgeHour}时/${next.skillHour}时`, "info");
					return;
				}
				case "run": {
					const purpose: DigestPurpose | undefined =
						parts[1] === "skill" ? "skill" : parts[1] === "knowledge" ? "knowledge" : undefined;
					if (!purpose) {
						notify(ctx, "用法: /knowledge run knowledge|skill", "warning");
						return;
					}
					const config = loadConfig({ projectDir: ctx.cwd });
					const prompt = buildDigestPrompt(purpose, config);
					notify(ctx, `立即执行${purpose === "knowledge" ? "知识" : "技能"}沉淀（当前会话）…`, "info");
					zharness.sendUserMessage(prompt, { deliverAs: "followUp" });
					return;
				}
				case "library": {
					const config = loadConfig({ projectDir: ctx.cwd });
					const root = resolveLibraryRoot({ destination: config.destination, projectDir: ctx.cwd });
					const stats = libraryStats(root);
					const lines = [
						`沉淀库（${root}）：知识 ${stats.knowledge.entries} 条/${stats.knowledge.categories} 类 · 技能 ${stats.skills.entries} 条/${stats.skills.categories} 类`,
					];
					if (stats.recentTitles.length > 0) {
						lines.push("最近条目:");
						for (const t of stats.recentTitles) lines.push(`  - ${t}`);
					}
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "disable": {
					const removed = removeScheduledTasks();
					persistDisabled(ctx.cwd, true);
					notify(
						ctx,
						`knowledge-forge 已禁用（移除定时任务 ${removed.length} 个），正在重载…`,
						"info",
					);
					await ctx.reload();
					return;
				}
				case "enable": {
					persistDisabled(ctx.cwd, false);
					notify(ctx, "knowledge-forge 已启用（将重建定时任务），正在重载…", "info");
					await ctx.reload();
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
