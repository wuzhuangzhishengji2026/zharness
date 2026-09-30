/**
 * 定时任务前端数据层(移植自 zharness 融合版,按高保真重构)。
 *
 * 后端 RPC(见 packages/rpc/rpc-mode.ts 的 schedule_* 分支)约定:
 *   - schedule_list 返回全 scope(main + 所有工作区)的任务,附带 nextRunAt
 *     与 workspaceCwd(项目名映射用);
 *   - 写操作带任务自身的 scope / workspaceId(真实 ws_<hash> id,来自任务
 *     对象或 WorkspaceMeta.workspace_id);
 *   - run_now 本地只对当前 sidecar 服务的 scope 生效(main 窗口跑 main,项目
 *     窗口跑自己);其他 scope 由后端写 runRequestedAt 请求标记落盘,拥有该
 *     scope 的 sidecar 引擎发现后触发(sidecar 未运行时,打开项目后补跑)。
 */

import { sendCommandAwait, type SidebarSessionInfo } from "@/lib/transport";
import type {
	ScheduledTaskSummary,
	SchedulerPolicy,
	ScheduledTaskRun,
	ScheduledTaskPatch,
	ScheduledTaskCreateInput,
	ScheduleSpec,
	TimeOfDay,
	Weekday,
} from "@zharness/protocol";

export interface TaskScope {
	scope: "main" | "workspace";
	workspaceId?: string;
}

export type TaskCardStatus = "active" | "paused" | "expired";

/**
 * 列表卡片的状态推导(设计稿:进行中/已暂停/已过期)。
 *
 * 「已过期」的判定必须先于「已暂停」:引擎对到期任务的落地动作就是置
 * enabled=false(endAt 越过、单次已执行、maxRuns 达标都是如此),若先判
 * enabled,已过期的任务会被误显示成已暂停。
 * - 到期:endAt 已过,或单次任务已到点执行过(fireAt 已过、runCount>0);
 *   被「立即运行」提前跑过但触发点仍在未来的单次任务仍算进行中(到点
 *   还会再触发)。
 */
export function taskStatus(task: ScheduledTaskSummary, now = Date.now()): TaskCardStatus {
	if (typeof task.schedule.endAt === "number" && task.schedule.endAt <= now) return "expired";
	if (task.schedule.mode === "once" && (task.runCount ?? 0) > 0) {
		const fireAt = typeof task.schedule.startAt === "number" ? task.schedule.startAt : task.createdAt;
		if (fireAt <= now) return "expired";
	}
	if (!task.enabled) return "paused";
	return "active";
}

/** 拉取全部定时任务(含 nextRunAt 摘要与所属项目 cwd)。失败时返回空数组。 */
export async function listScheduledTasks(): Promise<ScheduledTaskSummary[]> {
	try {
		const response = await sendCommandAwait<{ tasks?: ScheduledTaskSummary[] }>({ type: "schedule_list" }, 10000);
		return response.data?.tasks ?? [];
	} catch (e) {
		console.error("[scheduler] schedule_list error:", e);
		return [];
	}
}

/** 读取调度策略(新任务默认值)。失败返回 null。 */
export async function getSchedulerPolicy(): Promise<SchedulerPolicy | null> {
	try {
		const response = await sendCommandAwait<{ policy?: SchedulerPolicy }>({ type: "get_scheduler_policy" }, 8000);
		return response.data?.policy ?? null;
	} catch (e) {
		console.error("[scheduler] get_scheduler_policy error:", e);
		return null;
	}
}

/** 写入调度策略,返回更新后的策略;失败返回 null。 */
export async function setSchedulerPolicy(policy: SchedulerPolicy): Promise<SchedulerPolicy | null> {
	try {
		const response = await sendCommandAwait<{ policy?: SchedulerPolicy }>({ type: "set_scheduler_policy", policy }, 8000);
		return response.data?.policy ?? null;
	} catch (e) {
		console.error("[scheduler] set_scheduler_policy error:", e);
		return null;
	}
}

/** 新建定时任务。成功返回任务;失败抛错(表单需要展示原因)。 */
export async function createScheduledTask(
	scopeInfo: TaskScope,
	input: Omit<ScheduledTaskCreateInput, "scope" | "workspaceId">,
): Promise<ScheduledTaskSummary> {
	const response = await sendCommandAwait<{ task: ScheduledTaskSummary }>(
		{
			type: "schedule_create",
			task: { ...input, scope: scopeInfo.scope, workspaceId: scopeInfo.workspaceId },
		},
		10000,
	);
	return response.data!.task;
}

/** 更新定时任务(patch 内字段省略即保留)。失败抛错。 */
export async function updateScheduledTask(
	scopeInfo: TaskScope,
	taskId: string,
	patch: ScheduledTaskPatch,
): Promise<ScheduledTaskSummary> {
	const response = await sendCommandAwait<{ task: ScheduledTaskSummary }>(
		{ type: "schedule_update", taskId, patch, scope: scopeInfo.scope, workspaceId: scopeInfo.workspaceId },
		10000,
	);
	return response.data!.task;
}

/** 删除定时任务。失败抛错。 */
export async function deleteScheduledTask(scopeInfo: TaskScope, taskId: string): Promise<void> {
	await sendCommandAwait(
		{ type: "schedule_delete", taskId, scope: scopeInfo.scope, workspaceId: scopeInfo.workspaceId },
		8000,
	);
}

/** 立即触发一次定时任务。失败抛错(如任务不存在)。返回 fired=true 表示已
 * 派发(本地引擎或拥有方存活);fired=false 表示已写入请求标记排队——任务
 * 所属项目未打开,打开后由引擎自动补跑。 */
export async function runScheduledTaskNow(
	scopeInfo: TaskScope,
	taskId: string,
): Promise<{ fired: boolean; taskId: string; at: number }> {
	const response = await sendCommandAwait<{ fired: boolean; taskId: string; at: number }>(
		{ type: "schedule_run_now", taskId, scope: scopeInfo.scope, workspaceId: scopeInfo.workspaceId },
		30000,
	);
	return response.data ?? { fired: true, taskId, at: Date.now() };
}

/** 拉取指定任务的运行历史。失败返回空数组。 */
export async function getScheduledTaskHistory(
	scopeInfo: TaskScope,
	taskId: string,
	limit?: number,
): Promise<ScheduledTaskRun[]> {
	try {
		const response = await sendCommandAwait<{ runs?: ScheduledTaskRun[] }>(
			{ type: "schedule_history", taskId, scope: scopeInfo.scope, workspaceId: scopeInfo.workspaceId, limit: limit ?? 50 },
			10000,
		);
		return response.data?.runs ?? [];
	} catch (e) {
		console.error("[scheduler] schedule_history error:", e);
		return [];
	}
}

/**
 * 表单生成的两种「受限 cron」形态(高保真 22 画板):
 *   - 每年:后端 ScheduleMode 无 yearly,借 cron `分 时 日 月 *` 表达(设计稿 每年=月份+日期+时间);
 *   - 按间隔+星期:every_n 模式不支持星期限制,借 cron 小时步进(分钟字段固定 0、
 *     小时字段 star/step N)或分钟步进(分钟字段 star/step N)+ 星期受限字段表达。
 * cron 引擎(src/core/scheduler/cron.ts)按标准 5 字段语义展开,触发行为精确一致。
 */
export type ManagedCron =
	| { kind: "yearly"; month: number; day: number; time: TimeOfDay }
	| { kind: "interval"; n: number; unit: "minute" | "hour"; weekdays: Weekday[] };

/** 展开星期字段("1-5"、"1,3"、单个数字;7 归一化为 0=周日)。非法返回 null。 */
function expandCronWeekdays(raw: string): Weekday[] | null {
	const out = new Set<Weekday>();
	for (const part of raw.split(",")) {
		const range = /^(\d{1,2})-(\d{1,2})$/.exec(part);
		if (range) {
			const lo = Number(range[1]);
			const hi = Number(range[2]);
			if (lo < 0 || hi > 7 || lo > hi) return null;
			for (let d = lo; d <= hi; d++) out.add(d === 7 ? 0 : (d as Weekday));
		} else if (/^\d{1,2}$/.test(part)) {
			const d = Number(part);
			if (d < 0 || d > 7) return null;
			out.add(d === 7 ? 0 : (d as Weekday));
		} else {
			return null;
		}
	}
	return [...out].sort((a, b) => a - b);
}

/**
 * 识别本前端表单生成的受限 cron 形态;不匹配返回 null(保持 cron 高级模式展示)。
 * 仅识别由上方 ManagedCron 注释所列的两种形态,避免误吞用户手写的通用 cron。
 */
export function parseManagedCron(expr: string): ManagedCron | null {
	const s = expr.trim().replace(/\s+/g, " ");

	// 每年:`分 时 日 月 *`
	let m = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/.exec(s);
	if (m) {
		const minute = Number(m[1]);
		const hour = Number(m[2]);
		const day = Number(m[3]);
		const month = Number(m[4]);
		if (minute <= 59 && hour <= 23 && day >= 1 && day <= 31 && month >= 1 && month <= 12) {
			return { kind: "yearly", month, day, time: { hour, minute } };
		}
		return null;
	}

	// 间隔+星期:小时步进(分钟固定 0)/ 分钟步进;星期字段必须受限(非 star)。
	let minutesForm = false;
	m = /^0 \*\/(\d{1,2}) \* \* ([\d,-]+)$/.exec(s);
	if (!m) {
		minutesForm = true;
		m = /^\*\/(\d{1,2}) \* \* \* ([\d,-]+)$/.exec(s);
	}
	if (!m) return null;
	const n = Number(m[1]);
	const max = minutesForm ? 59 : 23;
	if (n < 1 || n > max) return null;
	const weekdays = expandCronWeekdays(m[2]!);
	if (!weekdays || weekdays.length === 0) return null;
	return { kind: "interval", n, unit: minutesForm ? "minute" : "hour", weekdays };
}

/** 根据排期生成人可读的中文描述(策略/展示用,不依赖 i18n)。 */
export function describeSchedule(spec: ScheduleSpec): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const fmtTime = (h?: number, m?: number) => (h === undefined || m === undefined ? "" : `${pad(h)}:${pad(m)}`);
	const firstTime = spec.times?.[0];
	switch (spec.mode) {
		case "every_n_minutes":
			return `每 ${spec.everyN?.n ?? 1} 分钟`;
		case "every_n_hours":
			return `每 ${spec.everyN?.n ?? 1} 小时`;
		case "daily":
			return firstTime ? `每天 ${fmtTime(firstTime.hour, firstTime.minute)}` : "每天";
		case "weekdays":
			return firstTime ? `工作日 ${fmtTime(firstTime.hour, firstTime.minute)}` : "工作日";
		case "weekly": {
			const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
			const days = spec.weekdays?.length ? spec.weekdays.map((d) => names[d] ?? "").filter(Boolean).join("、") : "每周";
			return firstTime ? `${days} ${fmtTime(firstTime.hour, firstTime.minute)}` : days;
		}
		case "monthly": {
			const days = spec.daysOfMonth?.length ? spec.daysOfMonth.join("、") : "每月";
			return firstTime ? `${days}日 ${fmtTime(firstTime.hour, firstTime.minute)}` : `${days}日`;
		}
		case "cron": {
			// 受限形态(本前端表单生成)转回人话;其余展示原始表达式。
			const managed = spec.cron?.expression ? parseManagedCron(spec.cron.expression) : null;
			if (managed?.kind === "yearly") {
				return `每年${managed.month}月${managed.day}日 ${fmtTime(managed.time.hour, managed.time.minute)}`;
			}
			if (managed?.kind === "interval") {
				const base = managed.unit === "hour" ? `每 ${managed.n} 小时` : `每 ${managed.n} 分钟`;
				if (managed.weekdays.length === 7) return base;
				const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
				return `${base}（仅${managed.weekdays.map((d) => names[d]).join("、")}）`;
			}
			return spec.cron?.expression ? `Cron: ${spec.cron.expression}` : "Cron";
		}
		case "once": {
			if (typeof spec.startAt === "number") {
				const d = new Date(spec.startAt);
				return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
			}
			return "单次";
		}
		default:
			return spec.mode;
	}
}

/** 把 epoch ms 格式化为本地时间字符串;空值返回占位。 */
export function formatTime(epochMs?: number | null): string {
	if (!epochMs) return "-";
	try {
		const d = new Date(epochMs);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	} catch {
		return "-";
	}
}

/**
 * 汇总某会话绑定的定时任务:当前会话 = 任务 pinned 会话、其同对话分组
 * (侧栏按首条用户消息聚合,引擎续写/用户重开产生的 fork 都在同一组,
 * session_ids 含组内全部会话 id)或其下游分支(引擎续写子会话后
 * sessionTarget.sessionId 已前移,后代匹配兜底保证卡片在整个分支内可见)。
 * 按最近触发时间降序。
 */
export function tasksForSession(
	tasks: ScheduledTaskSummary[],
	sessions: SidebarSessionInfo[],
	sessionId: string | null,
): ScheduledTaskSummary[] {
	if (!sessionId) return [];
	// parent_session_id → children
	const childrenOf = new Map<string, string[]>();
	// 会话 id → 所在对话分组的代表会话 id(侧栏行对应的会话)
	const groupRepOf = new Map<string, string>();
	for (const s of sessions) {
		const p = s.parent_session_id;
		if (p) {
			const list = childrenOf.get(p);
			if (list) list.push(s.session_id);
			else childrenOf.set(p, [s.session_id]);
		}
		for (const id of s.session_ids ?? [s.session_id]) {
			if (!groupRepOf.has(id)) groupRepOf.set(id, s.session_id);
		}
	}
	const currentGroupRep = groupRepOf.get(sessionId);
	const bound = tasks.filter((task) => {
		if (task.sessionTarget?.kind !== "pinned" || !task.sessionTarget.sessionId) return false;
		const root = task.sessionTarget.sessionId;
		// 同一对话分组(侧栏一行)内可见:引擎在续写后会把 pin 迁移到子会话,
		// 但用户从侧栏重开会话时代表会话会变成更新的 fork,仅靠后代遍历会漏。
		if (currentGroupRep !== undefined && groupRepOf.get(root) === currentGroupRep) return true;
		const seen = new Set<string>([root]);
		const queue = [root];
		while (queue.length) {
			const cur = queue.pop()!;
			if (cur === sessionId) return true;
			for (const child of childrenOf.get(cur) ?? []) {
				if (!seen.has(child)) {
					seen.add(child);
					queue.push(child);
				}
			}
		}
		return false;
	});
	return bound.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
}
