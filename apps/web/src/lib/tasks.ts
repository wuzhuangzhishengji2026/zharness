/**
 * 首页任务看板的数据层。
 *
 * 数据由内置扩展 `task-board` 提供（src/builtin-extensions/task-board），
 * 经 `task_board` RPC 命令读写当前工作区的 task-board.json；
 * 与 `task_board` agent 工具 / `/taskboard` 斜杠命令共用同一份数据。
 * 字段命名与禅道任务模型保持直观映射:
 *   title     ← 任务名称
 *   status    ← 任务状态 (doing / wait / done)
 *   priority  ← 优先级 (1/2/3 → high/medium/low)
 *   project   ← 所属项目/迭代
 *   createdAt ← 创建日期
 *   dueAt     ← 截止日期
 */

import { sendCommandAwait, subscribeEvents } from "./transport";
import type {
	RpcTaskBoardResult as TaskBoardResult,
	RpcTaskItem as TaskItem,
	RpcTaskPriority as TaskPriority,
	RpcTaskStatus as TaskStatus,
} from "./types";

export type { TaskStatus, TaskPriority, TaskItem };

/**
 * GUI 看板固定读写的目标工作区(主对话工作区 id)。
 * 看板是应用级独立页面,不跟随当前会话工作区切换——否则「开始任务」
 * 切到关联项目后,看板就换成了新项目的 task-board.json,原板上的
 * 状态更新看不到(刷新浏览器回到默认工作区才「恢复」)。
 * null = 跟随 sidecar 当前工作区(兼容未加载工作区列表的窗口期)。
 */
let boardWorkspaceId: string | null = null;

export function setTaskBoardWorkspace(id: string | null): void {
	boardWorkspaceId = id;
}

async function callTaskBoard(
	command: Record<string, unknown>,
): Promise<TaskBoardResult | null> {
	try {
		const response = await sendCommandAwait<TaskBoardResult>({
			type: "task_board",
			...(boardWorkspaceId ? { workspaceId: boardWorkspaceId } : {}),
			...command,
		});
		if (!response.success) {
			console.error("[tasks] task_board RPC failed:", response.error);
			return null;
		}
		return response.data ?? null;
	} catch (e) {
		// sidecar 未就绪 / 连接断开时按空数据处理，看板降级为空态而非报错。
		console.error("[tasks] task_board RPC error:", e);
		return null;
	}
}

/** 拉取任务列表。sidecar 不可达时返回空数组（看板显示空态）。 */
export async function listTasks(): Promise<TaskItem[]> {
	const result = await callTaskBoard({ action: "list" });
	return result?.action === "list" ? result.tasks : [];
}

/** 更新任务状态 (确认完成 / 创建任务 / 重新创建)。 */
export async function updateTaskStatus(
	id: string,
	next: TaskStatus,
): Promise<void> {
	await callTaskBoard({ action: "update", taskId: id, status: next });
}

/** 创建任务卡，返回新任务；失败时返回 null。 */
export async function createTask(input: {
	title: string;
	project?: string;
	priority?: TaskPriority;
	zentaoId?: string;
	dueAt?: string;
}): Promise<TaskItem | null> {
	const result = await callTaskBoard({ action: "create", ...input });
	return result?.action === "create" ? result.task : null;
}

/** 删除任务卡，返回是否删除成功。 */
export async function deleteTask(id: string): Promise<boolean> {
	const result = await callTaskBoard({ action: "delete", taskId: id });
	return result?.action === "delete" ? result.deleted : false;
}

/**
 * 订阅看板变更（agent 工具 / 斜杠命令 / 其他窗口改动任务时触发）。
 * 后端以 CUSTOM_MESSAGE(display:false, kind=task_board_changed) 事件广播,
 * 聊天流不渲染该事件;返回取消订阅函数。
 */
export function subscribeTaskBoardChanges(handler: () => void): () => void {
	// subscribeEvents 在 Tauri 模式下异步注册（listen()），这里适配成
	// 同步返回的取消函数，便于直接作为 useEffect cleanup 使用。
	let unlisten: (() => void) | undefined;
	void subscribeEvents((event) => {
		if (event.type !== "CUSTOM_MESSAGE") return;
		const payload = event.payload as { kind?: unknown; extension_id?: unknown } | undefined;
		if (payload?.extension_id === "task-board" && payload?.kind === "task_board_changed") {
			handler();
		}
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
}
