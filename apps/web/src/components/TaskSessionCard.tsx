import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	CalendarClock,
	ChevronDown,
	Loader2,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	Trash2,
} from "lucide-react";
import type { ScheduledTaskSummary } from "@zharness/protocol";
import { UiImg } from "@/components/UiImg";
import { isMainChatCwd } from "@/components/Layout";
import { listAllSessions, listWorkspaces, subscribeEvents } from "@/lib/transport";
import type { WorkspaceMeta } from "@/lib/types";
import {
	deleteScheduledTask,
	describeSchedule,
	listScheduledTasks,
	runScheduledTaskNow,
	taskStatus,
	tasksForSession,
	updateScheduledTask,
} from "@/lib/scheduler";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/views/automation/ConfirmDialog";
import { TaskDialog } from "@/views/automation/TaskDialog";

/**
 * 会话页底部悬浮的定时任务卡片(高保真 36 画板「查看任务」)。
 *
 * 数据自含:拉取全部任务 + 全工作区会话树,凡 pinned 会话是当前会话
 * (或其祖先)的任务即锚定到此会话;同会话多任务时默认展示最近触发的
 * 一个,可通过计数器切换。监听 SCHEDULED_TASK_FIRED/COMPLETED 事件做
 * 触发横幅与防抖刷新,ChatView 仅负责挂载。
 */

export default function TaskSessionCard({
	sessionId,
	workspace,
}: {
	sessionId: string | null;
	workspace?: string | null;
}) {
	const { t } = useTranslation();
	const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
	const [sessions, setSessions] = useState<Awaited<ReturnType<typeof listAllSessions>>>([]);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [confirmState, setConfirmState] = useState<{ kind: "pause" | "resume" | "delete"; task: ScheduledTaskSummary } | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ScheduledTaskSummary | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [runBusy, setRunBusy] = useState(false);
	const [firedTaskId, setFiredTaskId] = useState<string | null>(null);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		const [taskList, wsList, sessionList] = await Promise.all([
			listScheduledTasks(),
			listWorkspaces().catch(() => [] as WorkspaceMeta[]),
			listAllSessions().catch(() => []),
		]);
		setTasks(taskList);
		setWorkspaces(wsList.filter((ws) => !isMainChatCwd(ws.cwd)));
		setSessions(sessionList);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, sessionId]);

	// 锚定任务(供事件回调读取,避免重订阅)。
	const anchored = useMemo(() => tasksForSession(tasks, sessions, sessionId), [tasks, sessions, sessionId]);
	const anchoredRef = useRef(anchored);
	anchoredRef.current = anchored;

	// 任务触发/完成事件:本会话任务 → 触发横幅 + 防抖刷新。
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void subscribeEvents((event) => {
			const e = event as { type?: string; payload?: { taskId?: string } };
			const taskId = e.payload?.taskId;
			if (!taskId || !anchoredRef.current.some((x) => x.id === taskId)) return;
			if (e.type === "SCHEDULED_TASK_FIRED") {
				setFiredTaskId(taskId);
			} else if (e.type === "SCHEDULED_TASK_COMPLETED") {
				setFiredTaskId((cur) => (cur === taskId ? null : cur));
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

	// 会话切换后选中态失效回退到最近触发的任务。
	useEffect(() => {
		if (selectedId && !anchored.some((x) => x.id === selectedId)) setSelectedId(null);
	}, [anchored, selectedId]);

	const task = anchored.find((x) => x.id === selectedId) ?? anchored[0] ?? null;
	const scopeOf = (t0: ScheduledTaskSummary) => ({ scope: t0.scope, workspaceId: t0.workspaceId });

	const handleConfirm = useCallback(async () => {
		if (!confirmState) return;
		const { kind, task: target } = confirmState;
		setConfirmState(null);
		try {
			if (kind === "delete") {
				await deleteScheduledTask(scopeOf(target), target.id);
			} else {
				await updateScheduledTask(scopeOf(target), target.id, { enabled: kind === "resume" });
			}
			await refresh();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	}, [confirmState, refresh]);

	const handleRunNow = useCallback(async () => {
		if (!task) return;
		setRunBusy(true);
		try {
			const result = await runScheduledTaskNow(scopeOf(task), task.id);
			if (!result.fired) {
				// 任务所属项目的 sidecar 未运行:已排队,打开项目后自动执行。
				alert(t("automation.queued"));
			}
			void refresh();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setRunBusy(false);
		}
	}, [task, refresh, t]);

	if (!sessionId || !task) return null;
	// 已过期/已完成的任务:暂停/恢复是无效操作(引擎不会再排程它),不提供入口;
	// 立即运行保留——后端允许手动重跑一次性任务。
	const expired = taskStatus(task) === "expired";

	return (
		<div className="mx-auto w-full max-w-3xl px-6 pb-1.5">
			<div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_4px_16px_rgba(59,63,73,0.14)]">
				{firedTaskId === task.id && (
					<div className="mb-2 flex items-center gap-1.5 rounded-md bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent">
						<Loader2 className="h-3 w-3 animate-spin" />
						{t("automation.card.triggered")}
					</div>
				)}
				<div className="flex items-start gap-2.5">
					<UiImg src="/ui/sidebar/scheduled-active.png" size={18} className="mt-0.5 shrink-0" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="min-w-0 truncate text-sm font-semibold text-fg" title={task.name}>
								{task.name}
							</span>
							<span className="shrink-0 text-xs text-muted">{describeSchedule(task.schedule)}</span>
							{/* 同会话多任务切换器 */}
							{anchored.length > 1 && (
								<div className="relative shrink-0">
									<button
										type="button"
										onClick={() => setSwitcherOpen((v) => !v)}
										className="flex h-5 items-center gap-0.5 rounded-full bg-accent/10 px-1.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
									>
										{t("automation.card.moreTasks", { count: anchored.length - 1 })}
										<ChevronDown className={cn("h-2.5 w-2.5 transition-transform", switcherOpen && "rotate-180")} />
									</button>
									{switcherOpen && (
										<>
											<div className="fixed inset-0 z-10" onClick={() => setSwitcherOpen(false)} />
											<div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-[4px] border border-border bg-surface py-1 shadow-lg">
												{anchored.map((x) => (
													<button
														key={x.id}
														type="button"
														onClick={() => {
															setSelectedId(x.id);
															setSwitcherOpen(false);
														}}
														className={cn(
															"flex h-8 w-full items-center px-2.5 text-left text-xs transition-colors",
															x.id === task.id ? "bg-accent/10 font-medium text-accent" : "text-fg hover:bg-surface-2",
														)}
													>
														<span className="min-w-0 flex-1 truncate">{x.name}</span>
													</button>
												))}
											</div>
										</>
									)}
								</div>
							)}
						</div>
						<p className="mt-1 line-clamp-2 text-xs leading-4 text-muted" title={task.description || task.prompt}>
							{task.description || task.prompt}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setEditing(task);
								setDialogOpen(true);
							}}
							className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-fg transition-colors hover:bg-surface-2"
						>
							<Pencil className="h-3.5 w-3.5" />
							{t("common.edit")}
						</button>
						{!expired && (
							<button
								type="button"
								onClick={() => setConfirmState({ kind: task.enabled ? "pause" : "resume", task })}
								className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
							>
								{task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
								{task.enabled ? t("automation.pause") : t("automation.resume")}
							</button>
						)}
						<div className="relative">
							<button
								type="button"
								title={t("common.more")}
								onClick={() => setMenuOpen((v) => !v)}
								className={cn(
									"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
									menuOpen ? "bg-accent text-accent-fg" : "text-fg hover:bg-surface-2",
								)}
							>
								<MoreHorizontal className="h-4 w-4" />
							</button>
							{menuOpen && (
								<>
									<div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
									<div className="absolute right-0 top-full z-20 mt-1 w-[104px] rounded-[4px] border border-border bg-surface py-1 shadow-lg">
										<button
											type="button"
											disabled={runBusy}
											onClick={() => {
												setMenuOpen(false);
												void handleRunNow();
											}}
											className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
										>
											{runBusy ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : <CalendarClock className="h-4 w-4 text-muted" />}
											{t("automation.runNow")}
										</button>
										<button
											type="button"
											onClick={() => {
												setMenuOpen(false);
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
			</div>
			<ConfirmDialog
				kind={confirmState?.kind ?? null}
				taskName={confirmState?.task.name ?? ""}
				onClose={() => setConfirmState(null)}
				onConfirm={() => void handleConfirm()}
			/>
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
		</div>
	);
}
