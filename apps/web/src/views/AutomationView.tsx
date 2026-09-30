import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
	ChevronDown,
	Search,
	Loader2,
	CalendarClock,
	MoreHorizontal,
	Pause,
	Play,
	Pencil,
	Trash2,
	Plus,
	X,
} from "lucide-react";
import type { ScheduledTaskSummary, ScheduledTaskRun } from "@zharness/protocol";
import { EmptyState, PageHeader, Spinner } from "@/components/ui";
import { UiImg } from "@/components/UiImg";
import type { LayoutOutletContext } from "@/components/Layout";
import { isMainChatCwd } from "@/components/Layout";
import { subscribeEvents, listWorkspaces } from "@/lib/transport";
import type { WorkspaceMeta } from "@/lib/types";
import {
	deleteScheduledTask,
	describeSchedule,
	formatTime,
	getScheduledTaskHistory,
	listScheduledTasks,
	runScheduledTaskNow,
	taskStatus,
	updateScheduledTask,
} from "@/lib/scheduler";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/views/automation/ConfirmDialog";
import { TaskDialog } from "@/views/automation/TaskDialog";

/**
 * 定时任务(高保真 21/22/36 三画板)。
 * - 列表:3 列卡片网格(图标标题/两行备注/分隔线/排期·查看·⋯菜单),
 *   标题行右侧盒式筛选下拉 + 搜索框;立即运行/暂停/编辑/删除收进 ⋯ 下拉
 *   菜单;底部 sticky 通栏浅蓝「＋定时任务」创建条。
 * - 创建/编辑:640px 弹窗(r20),执行频率分段控件(周期/按间隔/单次;
 *   cron 不再作为选项,仅编辑历史 cron 任务时保留其表达式),
 *   周期含 每天每周每月每年(每年借 cron `分 时 日 月 *` 表达),按间隔支持
 *   星期限制(非空时借 cron 步进 + 星期受限表达);单次隐藏生效日期区间;
 *   高级设置三列(运行/并发/超时)+ 已启用复选。
 * - 暂停/恢复/删除:r30 确认弹窗。
 * - 查看:统一右侧信息抽屉(任务信息 + 运行历史 + 操作),不自动跳转会话
 *   页(切工作区加载整页卡);需要看完整对话时再用抽屉里的「跳转会话」。
 * 任务生成的会话(「每次新会话」)按普通会话出现在侧栏对应项目下。
 * 触发引擎按 scope 分布在 sidecar 内(main 窗口跑 main,项目窗口跑自己),
 * 其他项目的任务落盘后由该项目 sidecar 打开时接管;立即运行跨 scope 时
 * 后端写请求标记,由拥有方 sidecar 触发,前端延迟刷新兜底反馈。
 */

type FilterKey = "all" | "active" | "paused" | "expired";

/** 状态点:暂停=橙,过期=红(带同色 20% 光环);进行中/非定时无点。 */
function StatusDot({ tone }: { tone: "paused" | "expired" }) {
	const color = tone === "paused" ? "#FF9400" : "#CA0309";
	return (
		<span
			className="inline-block h-2 w-2 shrink-0 rounded-full"
			style={{ backgroundColor: color, boxShadow: `0 0 0 4px ${tone === "paused" ? "rgba(255,148,0,0.20)" : "rgba(202,3,9,0.20)"}` }}
		/>
	);
}

/** 查看任务:右侧抽屉(任务信息 + 运行历史 + 操作)。 */
function DetailDrawer({
	task,
	runs,
	loadingRuns,
	runBusy,
	runDone,
	onClose,
	onRunNow,
	onEdit,
	onOpenSession,
}: {
	task: ScheduledTaskSummary | null;
	runs: ScheduledTaskRun[];
	loadingRuns: boolean;
	runBusy: boolean;
	runDone: boolean;
	onClose: () => void;
	onRunNow: () => void;
	onEdit: () => void;
	onOpenSession: () => void;
}) {
	const { t } = useTranslation();
	if (!task) return null;
	const pinnedSessionId = task.sessionTarget?.kind === "pinned" ? task.sessionTarget.sessionId : undefined;
	const status = taskStatus(task);
	return (
		<div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={onClose}>
			<div
				className="flex h-full w-[440px] flex-col border-l border-border bg-surface shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-border px-5 py-4">
					<div className="flex min-w-0 items-center gap-2">
						<UiImg src="/ui/sidebar/scheduled-active.png" size={18} />
						<h3 className="truncate text-base font-semibold text-fg">{task.name}</h3>
					</div>
					<button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
					<dl className="space-y-2 text-sm">
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted">{t("automation.fields.frequency")}</dt>
							<dd className="text-right text-fg">{describeSchedule(task.schedule)}</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted">{t("automation.detail.nextRun")}</dt>
							<dd className="text-right text-fg">{formatTime(task.nextRunAt)}</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted">{t("automation.detail.lastRun")}</dt>
							<dd className="text-right text-fg">{formatTime(task.lastRunAt)}</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted">{t("automation.detail.status")}</dt>
							<dd className="flex items-center justify-end gap-1.5 text-fg">
								{(status === "paused" || status === "expired") && <StatusDot tone={status} />}
								{t(`automation.status.${status}`)}
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted">{t("automation.detail.runCount")}</dt>
							<dd className="text-right text-fg">{task.runCount ?? 0}</dd>
						</div>
					</dl>
					{task.description && (
						<p className="rounded-md border border-border bg-bg px-3 py-2 text-sm leading-relaxed text-muted">
							{task.description}
						</p>
					)}
					<div>
						<p className="mb-1.5 text-xs font-medium text-muted">{t("automation.fields.prompt")}</p>
						<p className="whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-sm leading-relaxed text-fg">
							{task.prompt}
						</p>
					</div>
					<div>
						<p className="mb-1.5 text-xs font-medium text-muted">{t("automation.detail.history")}</p>
						{loadingRuns ? (
							<div className="flex justify-center py-4"><Spinner /></div>
						) : runs.length === 0 ? (
							<p className="py-4 text-center text-xs text-muted">{t("automation.detail.noHistory")}</p>
						) : (
							<div className="space-y-1">
								{runs.map((run, i) => (
									<div key={`${run.at}-${i}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs">
										<span className="font-mono text-muted">{formatTime(run.at)}</span>
										<span
											className={cn(
												"rounded px-1.5 py-0.5 font-medium",
												run.status === "ok" ? "bg-success/10 text-success"
													: run.status === "failed" ? "bg-danger/10 text-danger"
														: "bg-surface-2 text-muted",
											)}
										>
											{t(`automation.runStatus.${run.status}`)}
										</span>
										{run.reason && <span className="min-w-0 flex-1 truncate text-muted" title={run.reason}>{run.reason}</span>}
									</div>
								))}
							</div>
						)}
					</div>
				</div>
				<div className="flex gap-2 border-t border-border px-5 py-4">
					<button
						type="button"
						disabled={runBusy}
						onClick={onRunNow}
						className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{runBusy ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<CalendarClock className="h-4 w-4" />
						)}
						{runBusy ? t("automation.triggering") : runDone ? t("automation.triggered") : t("automation.runNow")}
					</button>
					<button
						type="button"
						onClick={onEdit}
						className="h-9 flex-1 rounded-md border border-border text-sm text-fg transition-colors hover:bg-surface-2"
					>
						{t("common.edit")}
					</button>
					{pinnedSessionId && task.workspaceCwd && (
						<button
							type="button"
							onClick={onOpenSession}
							className="h-9 flex-1 rounded-md border border-border text-sm text-accent transition-colors hover:bg-accent/10"
						>
							{t("automation.openSession")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default function AutomationView({
	workspace,
	onOpenSession,
}: {
	workspace?: string | null;
	onOpenSession?: (cwd: string, sessionId: string) => void;
}) {
	const { t } = useTranslation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState<FilterKey>("all");
	const [filterOpen, setFilterOpen] = useState(false);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ScheduledTaskSummary | null>(null);
	const [confirmState, setConfirmState] = useState<{ kind: "pause" | "resume" | "delete"; task: ScheduledTaskSummary } | null>(null);
	const [drawerTask, setDrawerTask] = useState<ScheduledTaskSummary | null>(null);
	const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
	const [loadingRuns, setLoadingRuns] = useState(false);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		const [taskList, wsList] = await Promise.all([listScheduledTasks(), listWorkspaces().catch(() => [] as WorkspaceMeta[])]);
		setTasks(taskList);
		setWorkspaces(wsList.filter((ws) => !isMainChatCwd(ws.cwd)));
		// 打开中的抽屉同步到最新任务对象(runCount/nextRunAt/运行状态跟随刷新)。
		setDrawerTask((open) => (open ? taskList.find((t) => t.id === open.id) ?? open : open));
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 任务触发/完成事件 → 防抖刷新列表与抽屉。
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void subscribeEvents((event) => {
			const type = (event as { type?: string }).type;
			if (type === "SCHEDULED_TASK_FIRED" || type === "SCHEDULED_TASK_COMPLETED") {
				if (refreshTimer.current) clearTimeout(refreshTimer.current);
				refreshTimer.current = setTimeout(() => {
					refreshTimer.current = null;
					void refresh();
				}, 600);
			}
		}).then((fn) => {
			if (cancelled) {
				try { fn(); } catch { /* registry gone */ }
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			if (refreshTimer.current) clearTimeout(refreshTimer.current);
			try { unlisten?.(); } catch { /* registry gone */ }
		};
	}, [refresh]);

	// 抽屉打开时拉取运行历史;任务对象随 refresh 更新时静默重拉
	// (仅首次打开显示加载态,避免每次刷新都闪 spinner)。
	const loadedRunsTaskId = useRef<string | null>(null);
	useEffect(() => {
		if (!drawerTask) {
			loadedRunsTaskId.current = null;
			return;
		}
		let cancelled = false;
		if (loadedRunsTaskId.current !== drawerTask.id) {
			loadedRunsTaskId.current = drawerTask.id;
			setLoadingRuns(true);
		}
		void getScheduledTaskHistory(
			{ scope: drawerTask.scope, workspaceId: drawerTask.workspaceId },
			drawerTask.id,
		).then((list) => {
			if (!cancelled) {
				setRuns(list);
				setLoadingRuns(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [drawerTask]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return tasks.filter((task) => {
			if (filter !== "all" && taskStatus(task) !== filter) return false;
			if (!q) return true;
			return (
				task.name.toLowerCase().includes(q) ||
				task.prompt.toLowerCase().includes(q) ||
				(task.description ?? "").toLowerCase().includes(q)
			);
		});
	}, [tasks, filter, query]);

	const scopeOf = (task: ScheduledTaskSummary) => ({ scope: task.scope, workspaceId: task.workspaceId });

	/**
	 * 查看:统一右侧信息抽屉。不再按「有无 pinned 会话」分流到会话页——
	 * 切工作区加载整页又慢又打断当前窗口;抽屉即任务信息 + 运行历史,
	 * 需要看完整对话时用抽屉底部的「跳转会话」显式进入。
	 */
	const handleView = useCallback((task: ScheduledTaskSummary) => {
		setDrawerTask(task);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (!confirmState) return;
		const { kind, task } = confirmState;
		setConfirmState(null);
		try {
			if (kind === "delete") {
				await deleteScheduledTask(scopeOf(task), task.id);
			} else {
				await updateScheduledTask(scopeOf(task), task.id, { enabled: kind === "resume" });
			}
			await refresh();
		} catch (e) {
			console.error("[automation] action failed:", e);
			alert(e instanceof Error ? e.message : String(e));
		}
	}, [confirmState, refresh]);

	/** 查看抽屉的运行状态:触发中的任务 id / 已触发的任务 id。 */
	const [runNowBusyId, setRunNowBusyId] = useState<string | null>(null);
	const [runNowDoneId, setRunNowDoneId] = useState<string | null>(null);

	const handleRunNow = useCallback(async (task: ScheduledTaskSummary) => {
		setRunNowBusyId(task.id);
		setRunNowDoneId(null);
		const clickedAt = Date.now();
		try {
			const result = await runScheduledTaskNow(scopeOf(task), task.id);
			if (!result.fired) {
				// 任务所属项目的 sidecar 未运行:请求已落盘,打开项目后由引擎
				// 补跑。如实提示,别让用户以为已经在跑。
				alert(t("automation.queued"));
				return;
			}
			// fired=true:已派发,执行在后台进行。运行记录要等回合结束才落盘,
			// 完成事件只推给拥有方窗口——这里轮询运行历史直到本次运行出现,
			// 执行记录与列表状态随之刷新(事件到达时的防抖刷新也会命中)。
			setRunNowDoneId(task.id);
			setTimeout(() => setRunNowDoneId((cur) => (cur === task.id ? null : cur)), 6000);
			void refresh();
			const deadline = clickedAt + 120_000;
			const poll = setInterval(() => {
				if (Date.now() > deadline) {
					clearInterval(poll);
					return;
				}
				void getScheduledTaskHistory(scopeOf(task), task.id, 5)
					.then((runs) => {
						if (runs.some((run) => run.at >= clickedAt - 5000)) {
							clearInterval(poll);
							void refresh();
						}
					})
					.catch(() => clearInterval(poll));
			}, 2000);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setRunNowBusyId(null);
		}
	}, [refresh, t]);

	return (
		<div className="flex h-full flex-col">
			<div
				data-tauri-drag-region
				className={cn(
					"h-11 shrink-0 transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			/>
			<div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
				<PageHeader
					title={t("layout.scheduledTasks")}
					actions={
						<>
							{/* 筛选下拉(设计稿:174x34 盒式输入, r6) */}
							<div className="relative">
								<button
									type="button"
									onClick={() => setFilterOpen((v) => !v)}
									className="flex h-[34px] w-44 items-center justify-between gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-sm text-fg transition-colors hover:border-accent/40"
								>
									<span>{t(`automation.filter.${filter}`)}</span>
									<ChevronDown
										className={cn("h-3 w-3 shrink-0 text-muted transition-transform", filterOpen && "rotate-180")}
									/>
								</button>
								{filterOpen && (
									<>
										<div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
										<div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-[4px] border border-border bg-surface py-1 shadow-lg">
											{(["all", "active", "paused", "expired"] as FilterKey[]).map((key) => (
												<button
													key={key}
													type="button"
													onClick={() => {
														setFilter(key);
														setFilterOpen(false);
													}}
													className={cn(
														"flex h-9 w-full items-center px-3 text-left text-sm transition-colors",
														key === filter ? "bg-accent/10 font-medium text-accent" : "text-fg hover:bg-surface-2",
													)}
												>
													{t(`automation.filter.${key}`)}
												</button>
											))}
										</div>
									</>
								)}
							</div>
							{/* 搜索框(设计稿:326x34 盒式输入, r6) */}
							<div className="flex h-[34px] w-80 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 transition-colors focus-within:border-accent/40">
								<input
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder={t("automation.searchPlaceholder")}
									className="w-full bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none"
								/>
								<Search className="h-3.5 w-3.5 shrink-0 text-muted" />
							</div>
						</>
					}
				/>

				{loading ? (
					<div className="flex justify-center py-16"><Spinner /></div>
				) : filtered.length === 0 ? (
					<div className="py-10">
						<EmptyState
							icon={<UiImg src="/ui/sidebar/scheduled-active.png" size={40} />}
							title={tasks.length === 0 ? t("automation.emptyTitle") : t("automation.noMatchTitle")}
							description={tasks.length === 0 ? t("automation.emptyDescription") : undefined}
						/>
					</div>
				) : (
					<div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
						{filtered.map((task) => {
							const status = taskStatus(task);
							const menuOpen = menuOpenId === task.id;
							return (
								<div
									key={task.id}
									className="flex flex-col rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(59,63,73,0.10)] transition-shadow hover:shadow-[0_4px_12px_rgba(59,63,73,0.12)]"
								>
									{/* 标题行:图标 + 名称(设计稿 y+16) */}
									<div className="flex items-center gap-2">
										<UiImg src="/ui/sidebar/scheduled-active.png" size={17} className="shrink-0" />
										<span className="min-w-0 flex-1 truncate text-base font-semibold text-fg" title={task.name}>
											{task.name}
										</span>
									</div>
									{/* 备注:两行截断(设计稿 y+58) */}
									<p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted" title={task.description || task.prompt}>
										{task.description || task.prompt}
									</p>
									<div className="my-3 border-t border-border" />
									{/* 底部行:排期/状态 + 查看 + ⋯菜单(设计稿 y+128) */}
									<div className="flex items-center text-sm text-muted">
										<span className="min-w-0 flex-1 truncate">
											{status === "active" ? describeSchedule(task.schedule) : t(`automation.status.${status}`)}
										</span>
										<button
											type="button"
											onClick={() => void handleView(task)}
											className="shrink-0 text-sm text-accent transition-colors hover:opacity-80"
										>
											{t("automation.view")}
										</button>
										<div className="relative ml-1 shrink-0">
											<button
												type="button"
												title={t("common.more")}
												onClick={() => setMenuOpenId(menuOpen ? null : task.id)}
												className={cn(
													"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
													menuOpen ? "bg-accent text-accent-fg" : "text-fg hover:bg-surface-2",
												)}
											>
												<MoreHorizontal className="h-4 w-4" />
											</button>
											{menuOpen && (
												<>
													<div className="fixed inset-0 z-10" onClick={() => setMenuOpenId(null)} />
													<div className="absolute right-0 top-full z-20 mt-1 w-[104px] rounded-[4px] border border-border bg-surface py-1 shadow-lg">
														{/* 立即运行:所有任务可用(含已过期/单次的手动重跑);
														    跨 scope 的任务由后端写请求标记,拥有方 sidecar 触发 */}
														<button
															type="button"
															disabled={runNowBusyId === task.id}
															onClick={() => {
																setMenuOpenId(null);
																void handleRunNow(task);
															}}
															className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
														>
															{runNowBusyId === task.id ? (
																<Loader2 className="h-4 w-4 animate-spin text-muted" />
															) : (
																<CalendarClock className="h-4 w-4 text-muted" />
															)}
															{runNowBusyId === task.id ? t("automation.triggering") : t("automation.runNow")}
														</button>
														{/* 已过期/已完成的任务不再排程,暂停/恢复是无效操作,不提供入口 */}
														{status !== "expired" && (
														<button
															type="button"
															onClick={() => {
																setMenuOpenId(null);
																setConfirmState({ kind: task.enabled ? "pause" : "resume", task });
															}}
															className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
														>
															{task.enabled ? (
																<Pause className="h-4 w-4 text-muted" />
															) : (
																<Play className="h-4 w-4 text-muted" />
															)}
															{task.enabled ? t("automation.pause") : t("automation.resume")}
														</button>
													)}
														<button
															type="button"
															onClick={() => {
																setMenuOpenId(null);
																setEditing(task);
																setDialogOpen(true);
															}}
															className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
														>
															<Pencil className="h-4 w-4 text-muted" />
															{t("common.edit")}
														</button>
														<button
															type="button"
															onClick={() => {
																setMenuOpenId(null);
																setConfirmState({ kind: "delete", task });
															}}
															className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
														>
															<Trash2 className="h-4 w-4 text-muted" />
															{t("common.delete")}
														</button>
													</div>
												</>
											)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
				{/* 新建按钮(设计稿:底部通栏 50px 浅蓝条, r8,sticky 吸附) */}
				{!loading && (
					<div className="sticky bottom-0 mt-6">
						<button
							type="button"
							onClick={() => {
								setEditing(null);
								setDialogOpen(true);
							}}
							className="flex h-[50px] w-full items-center justify-center gap-2 rounded-lg bg-accent/10 text-lg font-semibold text-accent shadow-sm transition-colors hover:bg-accent/15"
						>
							<Plus className="h-5 w-5" />
							{t("automation.createTitle")}
						</button>
					</div>
				)}
			</div>

			<TaskDialog
				open={dialogOpen}
				editing={editing}
				workspaces={workspaces}
				currentWorkspace={workspace}
				onClose={() => setDialogOpen(false)}
				onSaved={() => {
					setDialogOpen(false);
					void refresh();
				}}
			/>
			<ConfirmDialog
				kind={confirmState?.kind ?? null}
				taskName={confirmState?.task.name ?? ""}
				onClose={() => setConfirmState(null)}
				onConfirm={() => void handleConfirm()}
			/>
			<DetailDrawer
				task={drawerTask}
				runs={runs}
				loadingRuns={loadingRuns}
				runBusy={drawerTask ? runNowBusyId === drawerTask.id : false}
				runDone={drawerTask ? runNowDoneId === drawerTask.id : false}
				onClose={() => setDrawerTask(null)}
				onRunNow={() => drawerTask && void handleRunNow(drawerTask)}
				onEdit={() => {
					setEditing(drawerTask);
					setDrawerTask(null);
					setDialogOpen(true);
				}}
				onOpenSession={() => {
					const sessionId = drawerTask?.sessionTarget?.kind === "pinned" ? drawerTask.sessionTarget.sessionId : undefined;
					const cwd = drawerTask?.workspaceCwd;
					if (sessionId && cwd) {
						setDrawerTask(null);
						onOpenSession?.(cwd, sessionId);
					}
				}}
			/>
		</div>
	);
}
