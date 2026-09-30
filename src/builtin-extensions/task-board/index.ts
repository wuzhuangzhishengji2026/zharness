/**
 * Built-in extension: task-board —— 任务看板。
 *
 * 为每个工作区维护一块持久化任务看板（task-board.json），三条入口同一份数据：
 *
 * 1. `task_board` agent 工具 —— LLM 可在会话中创建/更新/查询/删除任务卡，
 *    例如「把这个需求建一张任务卡」「把 xxx 标记为已完成」。
 * 2. `/taskboard` 斜杠命令 —— TUI/RPC 会话里人工管理任务
 *    （list / add / start / done / remove）。
 * 3. GUI 首页看板 —— Web 前端通过 `task_board` RPC 命令读写同一份数据
 *    （协议见 packages/protocol，分发见 packages/rpc/rpc-mode.ts）。
 *
 * 任务变更后向 EventStore 追加 CUSTOM_MESSAGE(display:false, kind=task_board_changed)
 * 事件，GUI 看板可订阅刷新，聊天流不渲染。
 *
 * Enable/disable state is persisted in `settings.json` under
 * `disabledBuiltinExtensions`（同 agent-browser 模式）。
 */

import { Type } from "@sinclair/typebox";
import { getAgentDir, SettingsManager } from "../../index.js";
import { deriveWorkspaceId } from "../../core/event-store/workspace.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import {
	createTask,
	deleteTask,
	emitTaskBoardChanged,
	isTaskPriority,
	listTasks,
	updateTask,
	type TaskItem,
} from "./store.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const TASK_BOARD_EXTENSION_ID = "task-board";

/** 解析当前工作区 id：优先事件库（GUI/RPC 会话），退化到 cwd 哈希（裸会话）。 */
function resolveWorkspaceId(ctx: ExtensionContext): string {
	return ctx.sessionManager.eventStore?.workspace_id ?? deriveWorkspaceId(ctx.cwd);
}

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

function persistDisabled(cwd: string, disabled: boolean): void {
	const settings = SettingsManager.create(cwd, getAgentDir());
	settings.setBuiltinExtensionDisabled(TASK_BOARD_EXTENSION_ID, disabled);
}

const STATUS_LABEL: Record<TaskItem["status"], string> = {
	not_started: "未开始",
	in_progress: "进行中",
	completed: "已完成",
};

const PRIORITY_LABEL: Record<TaskItem["priority"], string> = {
	high: "极高",
	medium: "中等",
	low: "一般",
};

function formatTaskLine(task: TaskItem): string {
	const zentao = task.zentaoId ? ` | 禅道:${task.zentaoId}` : "";
	return `  [${task.id}] ${STATUS_LABEL[task.status]} | ${PRIORITY_LABEL[task.priority]} | ${task.title} | ${task.project} | 截止 ${task.dueAt}${zentao}`;
}

function formatTaskList(tasks: TaskItem[]): string {
	if (tasks.length === 0) {
		return "看板暂无任务。用 /taskboard add <标题> 或让 agent 通过 task_board 工具创建。";
	}
	const counts = {
		not_started: tasks.filter((t) => t.status === "not_started").length,
		in_progress: tasks.filter((t) => t.status === "in_progress").length,
		completed: tasks.filter((t) => t.status === "completed").length,
	};
	const header = `任务看板（未开始 ${counts.not_started} / 进行中 ${counts.in_progress} / 已完成 ${counts.completed}）`;
	return [header, ...tasks.map(formatTaskLine)].join("\n");
}

/** 解析 add 子命令参数：`add <标题...> [--project X] [--priority high|medium|low] [--due YYYY-MM-DD] [--zentao ID]` */
function parseAddArgs(args: string): { title: string; project?: string; priority?: string; dueAt?: string; zentaoId?: string } | null {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flags = new Map<string, string>();
	const titleParts: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("--")) {
			const value = tokens[i + 1];
			if (value && !value.startsWith("--")) {
				flags.set(token.slice(2), value);
				i++;
			}
		} else {
			titleParts.push(token);
		}
	}
	const title = titleParts.join(" ").trim();
	if (!title) return null;
	return {
		title,
		project: flags.get("project"),
		priority: flags.get("priority"),
		dueAt: flags.get("due"),
		zentaoId: flags.get("zentao"),
	};
}

const USAGE = `Usage:
  /taskboard list                          列出看板任务
  /taskboard add <标题> [--project X] [--priority high|medium|low] [--due YYYY-MM-DD] [--zentao ID]
  /taskboard start <id>                    标记为进行中
  /taskboard done <id>                     标记为已完成
  /taskboard remove <id>                   删除任务
  /taskboard disable                       禁用本内置扩展（持久化）
  /taskboard enable                        重新启用
  /taskboard help                          显示本帮助

GUI 首页「任务看板」与本命令共用同一份数据（task-board.json）。`;

export const createTaskBoardExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	// ------------------------------------------------------------------
	// Agent 工具：让 LLM 在会话内直接管理任务卡
	// ------------------------------------------------------------------
	zharness.registerTool({
		name: "task_board",
		label: "Task Board",
		description:
			"Manage the workspace task board (persistent kanban). Actions: " +
			"'list' returns all task cards; 'create' adds a card (requires title; optional project, " +
			"priority high|medium|low, zentaoId, dueAt YYYY-MM-DD); 'update' patches a card (requires id; " +
			"optional title, project, priority, status not_started|in_progress|completed, zentaoId, dueAt); " +
			"'delete' removes a card (requires id). Use this when the user asks to track work items, " +
			"create task cards, or update task status on the board.",
		promptSnippet: "task_board: create/update/list/delete cards on the persistent workspace task board",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("delete"),
			]),
			id: Type.Optional(Type.String({ description: "Task id (required for update/delete)" })),
			title: Type.Optional(Type.String({ description: "Task title (required for create)" })),
			project: Type.Optional(Type.String({ description: "Project label, e.g. D6.0" })),
			priority: Type.Optional(
				Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
					description: "Priority: high=极高, medium=中等, low=一般",
				}),
			),
			status: Type.Optional(
				Type.Union([Type.Literal("not_started"), Type.Literal("in_progress"), Type.Literal("completed")], {
					description: "Board column status",
				}),
			),
			dueAt: Type.Optional(Type.String({ description: "Due date, YYYY-MM-DD" })),
			zentaoId: Type.Optional(Type.String({ description: "Linked ZenTao requirement/task id" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const workspaceId = resolveWorkspaceId(ctx);
			const store = ctx.sessionManager.eventStore;
			switch (params.action) {
				case "list": {
					const tasks = listTasks(workspaceId);
					return {
						content: [{ type: "text", text: formatTaskList(tasks) }],
						details: { tasks },
					};
				}
				case "create": {
					if (!params.title?.trim()) {
						throw new Error("task_board create: title is required");
					}
					const task = createTask(workspaceId, {
					title: params.title,
					project: params.project,
					priority: params.priority,
					status: params.status,
					zentaoId: params.zentaoId,
					dueAt: params.dueAt,
				});
					emitTaskBoardChanged(store, `创建任务：${task.title}`);
					return {
						content: [{ type: "text", text: `已创建任务卡：\n${formatTaskLine(task)}` }],
						details: { task },
					};
				}
				case "update": {
					if (!params.id) {
						throw new Error("task_board update: id is required");
					}
					const task = updateTask(workspaceId, params.id, {
					title: params.title,
					project: params.project,
					priority: params.priority,
					status: params.status,
					zentaoId: params.zentaoId,
					dueAt: params.dueAt,
				});
					if (!task) {
						return {
							content: [{ type: "text", text: `未找到任务 ${params.id}（可用 action=list 查看现有任务 id）。` }],
						};
					}
					emitTaskBoardChanged(store, `更新任务：${task.title} → ${STATUS_LABEL[task.status]}`);
					return {
						content: [{ type: "text", text: `已更新任务卡：\n${formatTaskLine(task)}` }],
						details: { task },
					};
				}
				case "delete": {
					if (!params.id) {
						throw new Error("task_board delete: id is required");
					}
					const deleted = deleteTask(workspaceId, params.id);
					if (deleted) {
						emitTaskBoardChanged(store, `删除任务：${params.id}`);
					}
					return {
						content: [
							{
								type: "text",
								text: deleted ? `已删除任务 ${params.id}。` : `未找到任务 ${params.id}。`,
							},
						],
						details: { deleted },
					};
				}
			}
		},
	});

	// ------------------------------------------------------------------
	// 斜杠命令：人工管理看板
	// ------------------------------------------------------------------
	zharness.registerCommand("taskboard", {
		description: "任务看板：管理当前工作区的持久化任务卡（与 GUI 首页看板同一份数据）。",
		getArgumentCompletions: (argumentPrefix) => {
			const subs = ["list", "add", "start", "done", "remove", "disable", "enable", "help"];
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			if (argumentPrefix.includes(" ")) return null;
			return subs.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const subcommand = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
			const rest = trimmed.slice(subcommand.length).trim();
			const workspaceId = resolveWorkspaceId(ctx);
			const store = ctx.sessionManager.eventStore;

			switch (subcommand) {
				case "list": {
					notify(ctx, formatTaskList(listTasks(workspaceId)), "info");
					return;
				}
				case "add": {
					const parsed = parseAddArgs(rest);
					if (!parsed) {
						notify(ctx, "缺少任务标题。用法：/taskboard add <标题> [--project X] [--priority high|medium|low] [--due YYYY-MM-DD]", "warning");
						return;
					}
					if (parsed.priority && !isTaskPriority(parsed.priority)) {
						notify(ctx, `无效优先级 "${parsed.priority}"（可选 high|medium|low）`, "warning");
						return;
					}
					const task = createTask(workspaceId, {
					title: parsed.title,
					project: parsed.project,
					priority: parsed.priority as TaskItem["priority"] | undefined,
					zentaoId: parsed.zentaoId,
					dueAt: parsed.dueAt,
				});
					emitTaskBoardChanged(store, `创建任务：${task.title}`);
					notify(ctx, `已创建任务卡：\n${formatTaskLine(task)}`, "info");
					return;
				}
				case "start":
				case "done": {
					if (!rest) {
						notify(ctx, `缺少任务 id。用法：/taskboard ${subcommand} <id>`, "warning");
						return;
					}
					const next = subcommand === "start" ? "in_progress" : "completed";
					const task = updateTask(workspaceId, rest, { status: next });
					if (!task) {
						notify(ctx, `未找到任务 ${rest}（/taskboard list 查看 id）`, "warning");
						return;
					}
					emitTaskBoardChanged(store, `更新任务：${task.title} → ${STATUS_LABEL[task.status]}`);
					notify(ctx, `已更新：\n${formatTaskLine(task)}`, "info");
					return;
				}
				case "remove": {
					if (!rest) {
						notify(ctx, "缺少任务 id。用法：/taskboard remove <id>", "warning");
						return;
					}
					const deleted = deleteTask(workspaceId, rest);
					if (deleted) {
						emitTaskBoardChanged(store, `删除任务：${rest}`);
					}
					notify(ctx, deleted ? `已删除任务 ${rest}。` : `未找到任务 ${rest}。`, deleted ? "info" : "warning");
					return;
				}
				case "disable": {
					persistDisabled(ctx.cwd, true);
					notify(ctx, "task-board 内置扩展已禁用，正在重载…", "info");
					await ctx.reload();
					return;
				}
				case "enable": {
					persistDisabled(ctx.cwd, false);
					notify(ctx, "task-board 内置扩展已启用，正在重载…", "info");
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
