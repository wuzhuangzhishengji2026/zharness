/**
 * Task board store —— 任务看板数据层。
 *
 * 每个工作区一个 JSON 文件：
 *   <agentDir>/workspaces/<workspace_id>/task-board.json
 *
 * 字段命名与 Web 端 `apps/web/src/lib/tasks.ts` 的 TaskItem 保持一致，
 * 与禅道任务模型直观映射（title/status/priority/project/createdAt/dueAt）。
 *
 * 变更通知：任务发生增删改后，调用方可选地通过 `emitTaskBoardChanged`
 * 向 EventStore 追加一条 `CUSTOM_MESSAGE`（display:false）事件。RPC 模式会把
 * 该事件原样转发给 GUI，GUI 聊天流不渲染 display:false 的负载，看板页面可
 * 订阅后自行刷新 —— 聊天内容不被污染。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkspaceDir } from "../../core/event-store/workspace.js";
import type { EventAppendInput } from "../../core/event-store/store.js";

export type TaskStatus = "not_started" | "in_progress" | "completed";
export type TaskPriority = "high" | "medium" | "low";

export interface TaskItem {
	id: string;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	/** 所属项目标签，如 "D6.0" / "国际化" / "智能体平台"。 */
	project: string;
	/** 关联的禅道需求/任务 ID（可选，有来源时填写）。 */
	zentaoId?: string;
	/** ISO 日期（YYYY-MM-DD）。 */
	createdAt: string;
	dueAt: string;
}

export interface CreateTaskInput {
	title: string;
	project?: string;
	priority?: TaskPriority;
	status?: TaskStatus;
	zentaoId?: string;
	/** YYYY-MM-DD；缺省为创建日期 +7 天。 */
	dueAt?: string;
}

export interface UpdateTaskPatch {
	title?: string;
	project?: string;
	priority?: TaskPriority;
	status?: TaskStatus;
	zentaoId?: string;
	dueAt?: string;
}

interface TaskBoardFile {
	version: 1;
	tasks: TaskItem[];
}

const VALID_STATUSES: readonly TaskStatus[] = ["not_started", "in_progress", "completed"];
const VALID_PRIORITIES: readonly TaskPriority[] = ["high", "medium", "low"];

export function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
	return typeof value === "string" && (VALID_PRIORITIES as readonly string[]).includes(value);
}

/** 看板数据文件路径（同时确保工作区目录存在）。 */
export function getTaskBoardPath(workspaceId: string, agentDir?: string): string {
	return join(getWorkspaceDir(workspaceId, agentDir), "task-board.json");
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(fromIso: string, days: number): string {
	const base = new Date(`${fromIso}T00:00:00Z`).getTime();
	return new Date(base + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function sanitizeTask(raw: unknown): TaskItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const t = raw as Record<string, unknown>;
	if (typeof t.id !== "string" || typeof t.title !== "string") return null;
	return {
		id: t.id,
		title: t.title,
		status: isTaskStatus(t.status) ? t.status : "not_started",
		priority: isTaskPriority(t.priority) ? t.priority : "medium",
		project: typeof t.project === "string" && t.project.length > 0 ? t.project : "默认",
		zentaoId: typeof t.zentaoId === "string" && t.zentaoId.length > 0 ? t.zentaoId : undefined,
		createdAt: typeof t.createdAt === "string" ? t.createdAt : todayIso(),
		dueAt: typeof t.dueAt === "string" ? t.dueAt : todayIso(),
	};
}

function readBoard(path: string): TaskBoardFile {
	if (!existsSync(path)) return { version: 1, tasks: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskBoardFile>;
		const tasks = Array.isArray(parsed.tasks)
			? parsed.tasks.map(sanitizeTask).filter((t): t is TaskItem => t !== null)
			: [];
		return { version: 1, tasks };
	} catch {
		// 损坏文件按空看板处理，不阻塞会话；下次写入时覆盖。
		return { version: 1, tasks: [] };
	}
}

function writeBoard(path: string, board: TaskBoardFile): void {
	// 原子写入：先写临时文件再 rename，避免半写状态损坏看板。
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(board, null, 2));
	renameSync(tmp, path);
}

/** 列出工作区全部任务（文件缺失/损坏时返回空数组）。 */
export function listTasks(workspaceId: string, agentDir?: string): TaskItem[] {
	return readBoard(getTaskBoardPath(workspaceId, agentDir)).tasks;
}

/** 创建任务，返回新任务。 */
export function createTask(workspaceId: string, input: CreateTaskInput, agentDir?: string): TaskItem {
	const path = getTaskBoardPath(workspaceId, agentDir);
	const board = readBoard(path);
	const createdAt = todayIso();
	const task: TaskItem = {
		id: `task_${randomUUID().slice(0, 8)}`,
		title: input.title.trim(),
		status: input.status ?? "not_started",
		priority: input.priority ?? "medium",
		project: input.project?.trim() || "默认",
		zentaoId: input.zentaoId?.trim() || undefined,
		createdAt,
		dueAt: input.dueAt?.trim() || plusDaysIso(createdAt, 7),
	};
	board.tasks.push(task);
	writeBoard(path, board);
	return task;
}

/** 更新任务，返回更新后的任务；id 不存在时返回 null。 */
export function updateTask(
	workspaceId: string,
	taskId: string,
	patch: UpdateTaskPatch,
	agentDir?: string,
): TaskItem | null {
	const path = getTaskBoardPath(workspaceId, agentDir);
	const board = readBoard(path);
	const task = board.tasks.find((t) => t.id === taskId);
	if (!task) return null;
	if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
	if (patch.project !== undefined) task.project = patch.project.trim() || task.project;
	if (patch.priority !== undefined && isTaskPriority(patch.priority)) task.priority = patch.priority;
	if (patch.status !== undefined && isTaskStatus(patch.status)) task.status = patch.status;
	if (patch.zentaoId !== undefined) task.zentaoId = patch.zentaoId.trim() || undefined;
	if (patch.dueAt !== undefined) task.dueAt = patch.dueAt.trim() || task.dueAt;
	writeBoard(path, board);
	return task;
}

/** 删除任务，返回是否删除成功。 */
export function deleteTask(workspaceId: string, taskId: string, agentDir?: string): boolean {
	const path = getTaskBoardPath(workspaceId, agentDir);
	const board = readBoard(path);
	const before = board.tasks.length;
	board.tasks = board.tasks.filter((t) => t.id !== taskId);
	if (board.tasks.length === before) return false;
	writeBoard(path, board);
	return true;
}

/** 事件接收面：EventStore 与 facade.runtime.store 都满足该形状。 */
interface AppendOnlyStore {
	append(event: EventAppendInput): unknown;
}

/**
 * 追加一条看板变更事件。display:false 保证 GUI 聊天流不渲染；
 * 事件经 RPC 转发后，看板页面可订阅 CUSTOM_MESSAGE(kind=task_board_changed) 刷新。
 */
export function emitTaskBoardChanged(store: AppendOnlyStore | undefined, summary: string): void {
	if (!store) return;
	try {
		store.append({
			actor_id: "task-board",
			type: "CUSTOM_MESSAGE",
			payload: {
				extension_id: "task-board",
				kind: "task_board_changed",
				data: summary,
				display: false,
			},
		});
	} catch {
		// 事件库不可用时静默降级 —— 看板数据已落盘，事件只是刷新提示。
	}
}
