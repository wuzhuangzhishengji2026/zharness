/**
 * 首页 = 任务看板 —— 按「看板高保真0907」设计稿实现。
 *
 * 数据由内置扩展 `task-board` 提供(见 src/builtin-extensions/task-board),
 * 经 lib/tasks 的 `task_board` RPC 读写,与 `task_board` agent 工具、
 * `/taskboard` 斜杠命令共用同一份数据(task-board.json);变更事件实时刷新。
 * 首次打开且看板为空时,放入设计稿样例数据(localStorage 标记,只 seed 一次)。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { Button, Modal } from "@/components/ui";
import { basename, cn } from "@/lib/utils";
import type { WorkspaceMeta } from "@/lib/types";
import {
	createTask,
	deleteTask,
	listTasks,
	setTaskBoardWorkspace,
	subscribeTaskBoardChanges,
	updateTaskStatus,
	type TaskItem,
	type TaskPriority,
	type TaskStatus,
} from "@/lib/tasks";
import { UiImg } from "@/components/UiImg";
import type { LayoutOutletContext } from "@/components/Layout";

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

const PRIORITY_STYLE: Record<TaskPriority, { dot: string; ring: string }> = {
	high: { dot: "bg-[#CA0309] dark:bg-[#FF0008]", ring: "ring-[#CA0309]/20 dark:ring-[#FF0008]/20" },
	medium: { dot: "bg-[#8F4EC6] dark:bg-[#C700FF]", ring: "ring-[#8F4EC6]/20 dark:ring-[#C700FF]/20" },
	low: { dot: "bg-[#00997B] dark:bg-[#00C7D4]", ring: "ring-[#00997B]/20 dark:ring-[#00C7D4]/20" },
};

/** 优先级筛选/选择胶囊的激活态 — 设计稿: 各自颜色的描边 + 同色浅底。 */
const PRIORITY_PILL_ACTIVE: Record<TaskPriority, string> = {
	high: "border-[#CA0309] bg-[#CA0309]/5 dark:border-[#FF0008] dark:bg-[#FF0008]/10",
	medium: "border-[#8F4EC6] bg-[#8F4EC6]/5 dark:border-[#C700FF] dark:bg-[#C700FF]/10",
	low: "border-[#00997B] bg-[#00997B]/5 dark:border-[#00C7D4] dark:bg-[#00C7D4]/10",
};

/** 列头渐变色带 — 设计稿: 浅色列头彩色字,深色列头白字 + 夜光渐变。 */
const COLUMN_STYLE: Record<TaskStatus, { header: string; title: string; count: string }> = {
	not_started: {
		header:
			"bg-[linear-gradient(90deg,rgba(255,165,0,0.20),rgba(255,165,0,0.03))] dark:bg-[linear-gradient(90deg,rgba(255,140,0,0.38),rgba(255,140,0,0.06))]",
		title: "text-[#7D482B] dark:text-white",
		count: "text-[#CC6F00] dark:text-white",
	},
	in_progress: {
		header:
			"bg-[linear-gradient(90deg,rgba(0,132,255,0.16),rgba(0,132,255,0.03))] dark:bg-[linear-gradient(90deg,rgba(0,132,255,0.38),rgba(0,132,255,0.06))]",
		title: "text-[#2A387E] dark:text-white",
		count: "text-[#0084FF] dark:text-white",
	},
	completed: {
		header:
			"bg-[linear-gradient(90deg,rgba(0,157,141,0.16),rgba(0,157,141,0.03))] dark:bg-[linear-gradient(90deg,rgba(0,200,150,0.32),rgba(0,200,150,0.06))]",
		title: "text-[#317169] dark:text-white",
		count: "text-[#009D8D] dark:text-white",
	},
};

/** TaskStatus → i18n 列键(board.column.*)。 */
const COLUMN_I18N_KEY: Record<TaskStatus, "todo" | "doing" | "done"> = {
	not_started: "todo",
	in_progress: "doing",
	completed: "done",
};

/** 设计稿样例数据 — 取自禅道典型需求清单,首次使用空看板时放入。 */
const SEED_FLAG = "task-board-seeded-v2";
const SEED_SAMPLES: Array<{
	title: string;
	project: string;
	priority: TaskPriority;
	status: TaskStatus;
	zentaoId: string;
	dueAt: string;
}> = [
	// 未开始 — 禅道「未确认 / 已分派」
	{ title: "工程需求单-沈阳D6.0负荷转供辅助决策适配科东人机改造", project: "南瑞统一软件平台（NUSP）", priority: "medium", status: "not_started", zentaoId: "45329", dueAt: "2026-09-25" },
	{ title: "[北海边缘集群]配网定值管理工具界面优化与新增需求", project: "边缘集群系统支撑平台", priority: "medium", status: "not_started", zentaoId: "45408", dueAt: "2026-09-26" },
	{ title: "工程需求单+上海新一代D6.0系统数据上云接口程序-增加遥测断面频率可配置功能", project: "配网新一代", priority: "low", status: "not_started", zentaoId: "44651", dueAt: "2026-09-30" },
	{ title: "新一代任务调度新增需求", project: "新一代电网调度控制系统", priority: "medium", status: "not_started", zentaoId: "36421", dueAt: "2026-09-28" },
	// 进行中 — 禅道「研发审核通过」
	{ title: "工程需求单+宁夏银川基于配电自动化主站系统的国产自主可控改造+D6.0+自动成图", project: "配网新一代", priority: "low", status: "in_progress", zentaoId: "43732", dueAt: "2026-09-18" },
	{ title: "【新增需求】dbi模型标准名称校验", project: "新一代变电站集中监控系统", priority: "high", status: "in_progress", zentaoId: "33994", dueAt: "2026-09-15" },
	// 已完成 — 禅道「已解决」
	{ title: "工程需求单-深圳调配一体化-配网AGC调控接口改造", project: "调配一体化", priority: "medium", status: "completed", zentaoId: "42848", dueAt: "2026-09-05" },
	{ title: "工程需求单-宁夏云主站-故障综合研判就地式FA逻辑优化", project: "配电物联网（IoT）云平台", priority: "medium", status: "completed", zentaoId: "35220", dueAt: "2026-09-02" },
];

type DateRange = "all" | "month1" | "month3" | "month6";
type SortBy = "priority" | "created" | "due";

/** 设计稿工具栏里的描边胶囊下拉 (全部项目 / 近三个月 / 按优先级排序)。 */
function PillSelect({
	value,
	options,
	onChange,
	className,
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	className?: string;
}) {
	return (
		<label
			className={cn(
				"relative flex h-8 items-center rounded-full border border-border bg-surface pl-3.5 pr-8 text-sm text-fg transition-colors hover:border-muted/50",
				className,
			)}
		>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-full w-full cursor-pointer appearance-none bg-transparent text-sm focus:outline-none"
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
			<UiImg src="/ui/action/dropdown.png" size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-70" />
		</label>
	);
}

function PriorityDot({ priority, className }: { priority: TaskPriority; className?: string }) {
	const s = PRIORITY_STYLE[priority];
	return <span className={cn("h-2 w-2 shrink-0 rounded-full ring-4", s.dot, s.ring, className)} />;
}

function TaskCard({
	task,
	onStart,
	onComplete,
	onDelete,
}: {
	task: TaskItem;
	onStart: (id: string) => void;
	onComplete: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-border bg-surface px-4 py-3.5 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-center gap-2">
				<PriorityDot priority={task.priority} />
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={task.title}>
					{task.title}
				</span>
				{/* 设计稿: 项目名为描边小胶囊 */}
				<span className="max-w-36 shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-xs text-muted" title={task.project}>
					{task.project}
				</span>
			</div>
			<div className="mt-2.5 flex items-center gap-4 text-xs text-muted">
				<span className="flex items-center gap-1.5">
					<UiImg src="/ui/schedule/calendar.png" size={14} />
					{t("board.createdAt", { date: task.createdAt })}
				</span>
				<span className="flex items-center gap-1.5">
					<UiImg src="/ui/schedule/deadline.png" size={14} />
					{t("board.dueAt", { date: task.dueAt })}
				</span>
			</div>
			<div className="mt-2.5 flex items-center gap-3">
				{task.status === "not_started" && (
					<button
						type="button"
						onClick={() => onStart(task.id)}
						className="flex items-center gap-1 text-xs font-medium text-[#0076FF] transition-colors hover:text-accent dark:text-[#3282FD]"
					>
						<UiImg src="/ui/action/start-task.png" size={14} />
						{t("board.startTask")}
					</button>
				)}
				{task.status === "in_progress" && (
					<button
						type="button"
						onClick={() => onComplete(task.id)}
						className="flex items-center gap-1 text-xs font-medium text-[#0076FF] transition-colors hover:text-accent dark:text-[#3282FD]"
					>
						<UiImg src="/ui/action/complete.png" size={14} />
						{t("board.completeTask")}
					</button>
				)}
				<button
					type="button"
					onClick={() => onDelete(task.id)}
					className="flex items-center gap-1 text-xs font-medium text-[#0076FF] transition-colors hover:text-danger dark:text-[#3282FD] dark:hover:text-danger"
				>
					<UiImg src="/ui/action/delete.png" size={14} />
					{t("board.deleteTask")}
				</button>
				<span className="flex-1" />
				{/* 设计稿: 来源为彩色软胶囊(禅道蓝 / 本地青) */}
				{task.zentaoId ? (
					<span className="shrink-0 rounded border border-[#0084FF]/20 bg-[#0084FF]/10 px-1.5 py-0.5 text-xs font-medium text-[#0084FF] dark:border-[#0084FF]/30 dark:bg-[#0084FF]/20 dark:text-[#3282FD]">
						{t("board.zentao", { id: task.zentaoId })}
					</span>
				) : (
					<span className="shrink-0 rounded border border-[#009695]/20 bg-[#009695]/10 px-1.5 py-0.5 text-xs font-medium text-[#009695] dark:border-[#00C7D4]/30 dark:bg-[#00C7D4]/20 dark:text-[#00C7D4]">
						{t("board.localSource")}
					</span>
				)}
			</div>
		</div>
	);
}

type StartFlow = "full" | "issue";
type StartType = "now" | "scheduled" | "periodic";

const START_TYPE_LABEL: Record<StartType, string> = {
	now: "typeNow",
	scheduled: "typeScheduled",
	periodic: "typePeriodic",
};

/**
 * 「开始任务」弹窗:选择任务类型(定时/周期留位,后端无调度能力先禁用)、
 * 研发流程与关联项目;确定后由 App 层在对应项目下创建会话并发出任务。
 */
function StartTaskModal({
	task,
	workspaces,
	currentWorkspace,
	onClose,
	onConfirm,
}: {
	task: TaskItem;
	workspaces: WorkspaceMeta[];
	currentWorkspace: string | null;
	onClose: () => void;
	onConfirm: (flow: StartFlow, projectCwd: string) => void;
}) {
	const { t } = useTranslation();
	const [type, setType] = useState<StartType>("now");
	const [flow, setFlow] = useState<StartFlow>("full");
	const [projectCwd, setProjectCwd] = useState(
		workspaces.some((ws) => ws.cwd === currentWorkspace) && currentWorkspace !== null
			? currentWorkspace
			: (workspaces[0]?.cwd ?? ""),
	);

	const typeOptions: Array<{ id: StartType; disabled: boolean }> = [
		{ id: "now", disabled: false },
		{ id: "scheduled", disabled: true },
		{ id: "periodic", disabled: true },
	];
	const flowOptions: StartFlow[] = ["full", "issue"];

	return (
		<Modal
			open
			onClose={onClose}
			title={t("board.startModal.title")}
			footer={
				<>
					<Button tone="neutral" variant="outline" onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button tone="accent" disabled={projectCwd === "" || type !== "now"} onClick={() => onConfirm(flow, projectCwd)}>
						{t("board.startModal.confirm")}
					</Button>
				</>
			}
		>
			<div className="space-y-4">
				<p className="truncate rounded-md bg-surface-2 px-3 py-2 text-sm text-fg" title={task.title}>
					{task.title}
				</p>
				<div>
					<label className="label">{t("board.startModal.type")}</label>
					<div className="grid grid-cols-3 gap-2">
						{typeOptions.map((opt) => (
							<button
								key={opt.id}
								type="button"
								disabled={opt.disabled}
								onClick={() => setType(opt.id)}
								className={cn(
									"rounded-lg border px-3 py-2 text-left transition-colors",
									opt.disabled && "cursor-not-allowed opacity-50",
									type === opt.id && !opt.disabled
										? "border-accent bg-accent/10"
										: "border-border bg-surface hover:border-muted/50",
								)}
							>
								<div className="text-sm font-medium text-fg">{t(`board.startModal.${START_TYPE_LABEL[opt.id]}`)}</div>
								<div className="mt-0.5 text-[11px] text-muted">
									{opt.disabled ? t("board.startModal.comingSoon") : t("board.startModal.typeNowDesc")}
								</div>
							</button>
						))}
					</div>
				</div>
				<div>
					<label className="label">{t("board.startModal.flow")}</label>
					<div className="grid grid-cols-2 gap-2">
						{flowOptions.map((f) => (
							<button
								key={f}
								type="button"
								onClick={() => setFlow(f)}
								className={cn(
									"rounded-lg border px-3 py-2 text-left transition-colors",
									flow === f ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-muted/50",
								)}
							>
								<div className="text-sm font-medium text-fg">
									{t(f === "full" ? "board.startModal.flowFull" : "board.startModal.flowIssue")}
								</div>
								<div className="mt-0.5 text-[11px] text-muted">
									{t(f === "full" ? "board.startModal.flowFullDesc" : "board.startModal.flowIssueDesc")}
								</div>
							</button>
						))}
					</div>
				</div>
				<div>
					<label className="label">{t("board.startModal.project")}</label>
					{workspaces.length === 0 ? (
						<p className="text-xs text-muted">{t("board.startModal.projectEmpty")}</p>
					) : (
						<select
							value={projectCwd}
							onChange={(e) => setProjectCwd(e.target.value)}
							className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
						>
							{workspaces.map((ws) => (
								<option key={ws.workspace_id} value={ws.cwd}>
									{basename(ws.cwd)}
								</option>
							))}
						</select>
					)}
				</div>
			</div>
		</Modal>
	);
}

function KanbanColumn({
	status,
	tasks,
	onStart,
	onComplete,
	onDelete,
}: {
	status: TaskStatus;
	tasks: TaskItem[];
	onStart: (id: string) => void;
	onComplete: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation();
	const style = COLUMN_STYLE[status];
	return (
		<section className="flex min-h-0 flex-col rounded-xl bg-surface-2">
			<header className={cn("flex items-center gap-2 rounded-t-xl px-4 py-3", style.header)}>
				<h2 className={cn("text-sm font-semibold", style.title)}>
					{t(`board.column.${COLUMN_I18N_KEY[status]}`)}
				</h2>
				<span className={cn("text-base font-bold", style.count)}>{tasks.length}</span>
			</header>
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-3">
				{tasks.length === 0 ? (
					<p className="py-8 text-center text-xs text-muted">{t("board.empty")}</p>
				) : (
					tasks.map((task) => (
						<TaskCard
							key={task.id}
							task={task}
							onStart={onStart}
							onComplete={onComplete}
							onDelete={onDelete}
						/>
					))
				)}
			</div>
		</section>
	);
}

export default function HomeView({
	workspace = null,
	sidecarReady = true,
	workspaces = [],
	boardWorkspaceId = null,
	onStartTask,
}: {
	workspace?: string | null;
	sidecarReady?: boolean;
	workspaces?: WorkspaceMeta[];
	/** 看板固定读写的工作区 id(主对话工作区);null 时跟随 sidecar 当前工作区。 */
	boardWorkspaceId?: string | null;
	onStartTask?: (input: { title: string; zentaoId?: string; flow: StartFlow; projectCwd: string }) => void;
}) {
	const { t } = useTranslation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [priorityFilter, setPriorityFilter] = useState<Set<TaskPriority>>(new Set());
	const [project, setProject] = useState("all");
	const [range, setRange] = useState<DateRange>("month3");
	const [sortBy, setSortBy] = useState<SortBy>("priority");
	const [search, setSearch] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [startTarget, setStartTarget] = useState<TaskItem | null>(null);

	// 创建任务表单
	const [draftTitle, setDraftTitle] = useState("");
	const [draftProject, setDraftProject] = useState("");
	const [draftPriority, setDraftPriority] = useState<TaskPriority>("medium");
	const [draftZentao, setDraftZentao] = useState("");
	const [draftDue, setDraftDue] = useState("");

	useEffect(() => {
		// 看板是应用级独立页面:固定读写主对话工作区,不随「开始任务」
		// 切换会话工作区而换板(否则切到关联项目后看到的是新项目的板,
		// 原板上的状态更新要等浏览器刷新回到默认工作区才显现)。
		setTaskBoardWorkspace(boardWorkspaceId);
		// sidecar 未就绪时不发命令(浏览器端命令会 503 静默丢失后按空数据
		// 渲染,造成「看板时有时无」);就绪/看板工作区确定后重拉。
		if (!sidecarReady) return;
		let cancelled = false;
		void (async () => {
			let items = await listTasks();
			// 看板数据按工作区隔离(task-board.json),seed 标记也必须按工作区,
			// 否则只在第一个工作区放过样例,其他工作区永远空白。
			if (items.length === 0) {
				try {
					const flag = `${SEED_FLAG}:${boardWorkspaceId ?? workspace ?? ""}`;
					if (!localStorage.getItem(flag)) {
						localStorage.setItem(flag, "1");
						for (const sample of SEED_SAMPLES) {
							await createTask(sample);
						}
						items = await listTasks();
					}
				} catch {
					/* localStorage 不可用时跳过 seed */
				}
			}
			if (!cancelled) setTasks(items);
		})();
		// agent 工具 / 斜杠命令 / 其他窗口改动看板时实时刷新。
		const unsubscribe = subscribeTaskBoardChanges(() => {
			void listTasks().then((items) => {
				if (!cancelled) setTasks(items);
			});
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sidecarReady, boardWorkspaceId, workspace]);

	const projects = useMemo(
		() => Array.from(new Set(tasks.map((task) => task.project))),
		[tasks],
	);

	const visibleTasks = useMemo(() => {
		const query = search.trim().toLowerCase();
		const rangeDays: Record<DateRange, number> = { all: Infinity, month1: 31, month3: 93, month6: 186 };
		return tasks
			.filter((task) => {
				if (priorityFilter.size > 0 && !priorityFilter.has(task.priority)) return false;
				if (project !== "all" && task.project !== project) return false;
				if (range !== "all") {
					const created = new Date(task.createdAt);
					if ((Date.now() - created.getTime()) / 86400000 > rangeDays[range]) return false;
				}
				if (query && !task.title.toLowerCase().includes(query)) return false;
				return true;
			})
			.sort((a, b) => {
				if (sortBy === "priority") return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
				if (sortBy === "created") return b.createdAt.localeCompare(a.createdAt);
				return a.dueAt.localeCompare(b.dueAt);
			});
	}, [tasks, priorityFilter, project, range, sortBy, search]);

	const togglePriority = (p: TaskPriority) =>
		setPriorityFilter((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});

	/** 乐观更新 + RPC 落盘;变更事件回来后再以服务端数据为准。 */
	const moveTask = (id: string, next: TaskStatus) => {
		setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, status: next } : task)));
		void updateTaskStatus(id, next);
	};
	const handleDelete = (id: string) => {
		setTasks((prev) => prev.filter((task) => task.id !== id));
		void deleteTask(id);
	};

	const resetDraft = () => {
		setDraftTitle("");
		setDraftProject("");
		setDraftPriority("medium");
		setDraftZentao("");
		setDraftDue("");
	};
	const handleCreate = () => {
		const title = draftTitle.trim();
		if (!title) return;
		void createTask({
			title,
			project: draftProject.trim() || undefined,
			priority: draftPriority,
			zentaoId: draftZentao.trim() || undefined,
			dueAt: draftDue || undefined,
		}).then(async (task) => {
			if (task) {
				setTasks(await listTasks());
			}
		});
		setCreateOpen(false);
		resetDraft();
	};

	const priorities: TaskPriority[] = ["high", "medium", "low"];
	const columns: TaskStatus[] = ["not_started", "in_progress", "completed"];

	return (
		<div className="flex h-full flex-col">
			{/* Window drag strip — 与其他页面保持一致的顶部占位 */}
			<div
				data-tauri-drag-region
				className={cn(
					"h-11 shrink-0 transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			/>

			{/* 标题 + 工具栏 (设计稿: 同一行) */}
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-3 pt-2">
				<h1 className="text-lg font-semibold text-fg">{t("board.title")}</h1>
				<div className="flex flex-wrap items-center gap-2">
					{priorities.map((p) => {
						const active = priorityFilter.has(p);
						return (
							<button
								key={p}
								type="button"
								onClick={() => togglePriority(p)}
								className={cn(
									"flex h-8 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors",
									active
										? PRIORITY_PILL_ACTIVE[p] + " font-medium text-fg"
										: "border-border bg-surface text-fg hover:border-muted/50",
								)}
							>
								<PriorityDot priority={p} className="ring-0" />
								{t(`board.priority.${p}`)}
							</button>
						);
					})}
					<PillSelect
						value={project}
						onChange={setProject}
						options={[
							{ value: "all", label: t("board.allProjects") },
							...projects.map((p) => ({ value: p, label: p })),
						]}
					/>
					<PillSelect
						value={range}
						onChange={(v) => setRange(v as DateRange)}
						options={[
							{ value: "month1", label: t("board.range.month1") },
							{ value: "month3", label: t("board.range.month3") },
							{ value: "month6", label: t("board.range.month6") },
							{ value: "all", label: t("board.range.all") },
						]}
					/>
					<PillSelect
						value={sortBy}
						onChange={(v) => setSortBy(v as SortBy)}
						options={[
							{ value: "priority", label: t("board.sort.priority") },
							{ value: "created", label: t("board.sort.created") },
							{ value: "due", label: t("board.sort.due") },
						]}
					/>
				</div>
				<div className="ml-auto flex h-8 w-56 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5">
					<UiImg src="/ui/action/search.png" size={14} />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("board.searchPlaceholder")}
						className="w-full bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none"
					/>
				</div>
			</div>

			{/* 三列看板 */}
			<div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-6 pb-4 lg:grid-cols-3 lg:overflow-hidden">
				{columns.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						tasks={visibleTasks.filter((task) => task.status === status)}
						onStart={(id) => {
							const task = tasks.find((x) => x.id === id);
							if (task) setStartTarget(task);
						}}
						onComplete={(id) => moveTask(id, "completed")}
						onDelete={handleDelete}
					/>
				))}
			</div>

			{/* 底部创建任务条 (设计稿: 通栏浅蓝圆角条) */}
			<div className="shrink-0 px-6 pb-5">
				<button
					type="button"
					onClick={() => setCreateOpen(true)}
					className="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-[#0084FF]/10 text-sm font-medium text-[#0076FF] transition-colors hover:bg-[#0084FF]/20 dark:bg-[#0084FF]/20 dark:text-[#3282FD] dark:hover:bg-[#0084FF]/30"
				>
					<UiImg src="/ui/action/create-task.png" size={16} />
					{t("board.createTask")}
				</button>
			</div>

			<Modal
				open={createOpen}
				onClose={() => {
					setCreateOpen(false);
					resetDraft();
				}}
				title={t("board.createTask")}
				footer={
					<>
						<Button tone="neutral" variant="outline" onClick={() => { setCreateOpen(false); resetDraft(); }}>
							{t("common.cancel")}
						</Button>
						<Button tone="accent" onClick={handleCreate} disabled={!draftTitle.trim()}>
							{t("common.confirm")}
						</Button>
					</>
				}
			>
				<div className="space-y-3">
					<div>
						<label className="label">{t("board.form.title")}</label>
						<input
							autoFocus
							value={draftTitle}
							onChange={(e) => setDraftTitle(e.target.value)}
							placeholder={t("board.form.titlePlaceholder")}
							className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div>
							<label className="label">{t("board.form.project")}</label>
							<input
								value={draftProject}
								onChange={(e) => setDraftProject(e.target.value)}
								placeholder={t("board.form.projectPlaceholder")}
								className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							/>
						</div>
						<div>
							<label className="label">{t("board.form.zentao")}</label>
							<input
								value={draftZentao}
								onChange={(e) => setDraftZentao(e.target.value)}
								placeholder={t("board.form.zentaoPlaceholder")}
								className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							/>
						</div>
						<div>
							<label className="label">{t("board.form.due")}</label>
							<input
								type="date"
								value={draftDue}
								onChange={(e) => setDraftDue(e.target.value)}
								className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
							/>
						</div>
					</div>
					<div>
						<label className="label">{t("board.form.priority")}</label>
						<div className="flex gap-2">
							{priorities.map((p) => (
								<button
									key={p}
									type="button"
									onClick={() => setDraftPriority(p)}
									className={cn(
										"flex h-8 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors",
										draftPriority === p
											? PRIORITY_PILL_ACTIVE[p] + " font-medium text-fg"
											: "border-border bg-surface text-muted hover:text-fg",
									)}
								>
									<PriorityDot priority={p} className="ring-0" />
									{t(`board.priority.${p}`)}
								</button>
							))}
						</div>
					</div>
				</div>
			</Modal>

			{startTarget !== null && (
				<StartTaskModal
					task={startTarget}
					workspaces={workspaces}
					currentWorkspace={workspace}
					onClose={() => setStartTarget(null)}
					onConfirm={(flow, projectCwd) => {
						const target = startTarget;
						// 乐观更新先看齐;状态落盘完成后再让 App 切项目执行——
						// 切工作区会重启 sidecar,update 与重启并发会把请求打死在半路上。
						setTasks((prev) => prev.map((task) => (task.id === target.id ? { ...task, status: "in_progress" } : task)));
						void (async () => {
							await updateTaskStatus(target.id, "in_progress");
							onStartTask?.({
								title: target.title,
								zentaoId: target.zentaoId,
								flow,
								projectCwd,
							});
						})();
						setStartTarget(null);
					}}
				/>
			)}
		</div>
	);
}
