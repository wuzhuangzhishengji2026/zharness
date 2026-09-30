import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
	Settings as SettingsIcon,
	Plus,
	Folder,
	MoreHorizontal,
	Pin,
	FolderOpen,
	Trash2,
	PanelLeft,
	ChevronDown,
	MessageSquare,
	ListFilter,
	Check,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StatusDot, ThemeToggle } from "./ui";
import { ToggleIcon, UiImg } from "./UiImg";
import WorkspacePane from "./WorkspacePane";
import { PersonaCard } from "./PersonaCard";
import { basename, cn } from "@/lib/utils";
import { deleteWorkspace, revealWorkspace, type SidebarSessionInfo } from "@/lib/transport";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

/** 会话子行默认显示数量,超出折叠为「还有 N 个会话」。 */
const SESSIONS_PREVIEW_COUNT = 4;

const PINNED_KEY = "zharness:pinned-workspaces";
const COLLAPSED_KEY = "zharness:sidebar-collapsed";
/** Max workspace rows shown in the 项目 group before the 展开更多 toggle. */
const WORKSPACE_PREVIEW_COUNT = 5;

/** Context passed to routed views so their top header can clear the macOS traffic lights + toggle when the sidebar is collapsed. */
export type LayoutOutletContext = { sidebarCollapsed: boolean };

function getPinnedWorkspaces(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		if (raw) return new Set(JSON.parse(raw) as string[]);
	} catch { /* ignore */ }
	return new Set();
}

function setPinnedWorkspaces(ids: Set<string>): void {
	try {
		localStorage.setItem(PINNED_KEY, JSON.stringify([...ids]));
	} catch { /* ignore */ }
}

function WorkspaceMenu({ ws, onPin, isPinned, onDelete, onClose }: {
	ws: WorkspaceMeta;
	onPin: () => void;
	isPinned: boolean;
	onDelete: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [onClose]);

	return (
		<div
			ref={menuRef}
			className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-border bg-surface py-1 shadow-lg"
			onClick={(e) => e.stopPropagation()}
		>
			<button
				type="button"
				onClick={() => { onPin(); onClose(); }}
				className={cn(FOCUS_RING, "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-fg transition-colors hover:bg-accent/10 hover:text-accent")}
			>
				<Pin className={cn("h-3.5 w-3.5 shrink-0", isPinned ? "text-accent" : "text-muted")} aria-hidden="true" />
				<span>{isPinned ? t("layout.unpin") : t("layout.pinToTop")}</span>
			</button>
			<button
				type="button"
				onClick={() => { void revealWorkspace(ws.cwd); onClose(); }}
				className={cn(FOCUS_RING, "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-fg transition-colors hover:bg-accent/10 hover:text-accent")}
			>
				<FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
				<span>{t("layout.revealInFiles")}</span>
			</button>
			<button
				type="button"
				onClick={() => { onDelete(); onClose(); }}
				className={cn(FOCUS_RING, "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10")}
			>
				<Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span>{t("common.delete")}</span>
			</button>
		</div>
	);
}

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function timeAgo(ts: number, t: TFunction): string {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60000);
	if (min < 1) return t("layout.timeJustNow");
	if (min < 60) return t("layout.timeMinutesAgo", { count: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("layout.timeHoursAgo", { count: hr });
	const days = Math.floor(hr / 24);
	return t("layout.timeDaysAgo", { count: days });
}

const MAIN_CHAT_CWD = "~/.zharness/main";

/** 是否主对话工作区(~/.zharness/main 或其展开绝对路径,兼容 Windows 反斜杠)。 */
export function isMainChatCwd(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	if (cwd === MAIN_CHAT_CWD) return true;
	// Match expanded path like /Users/tom/.zharness/main
	return cwd.replace(/\\/g, "/").endsWith("/.zharness/main");
}

/** 路径归一化比较(Windows 反斜杠 + 大小写盘符)。 */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

/** 侧栏会话子行(挂在所属工作区行下,含主对话工作区)。 */
function SessionRow({
	session,
	active,
	onClick,
}: {
	session: SidebarSessionInfo;
	active: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				FOCUS_RING,
				"ml-5 flex w-[calc(100%-1.25rem)] cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors",
				active
					? "border-border bg-surface dark:bg-surface-3"
					: "border-transparent hover:bg-surface-2 dark:hover:bg-surface-3",
			)}
			title={session.name || session.title}
		>
			<MessageSquare className={cn("h-3 w-3 shrink-0", active ? "text-accent" : "text-muted")} aria-hidden="true" />
			<span className={cn(
				"min-w-0 flex-1 truncate text-[12px] leading-5",
				active ? "font-medium text-accent" : "text-fg",
			)}>
				{session.name || session.title || t("layout.untitledSession")}
			</span>
			<span className="shrink-0 text-[10px] tabular-nums text-muted/70">{timeAgo(session.created_at, t)}</span>
		</button>
	);
}

/** 键盘焦点环 — 侧栏所有可交互元素共享(Web Interface Guidelines: 不得裸用 outline-none)。 */
const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/** Sidebar menu row — shared by NavLink entries and action buttons so the
 * active/hover visuals stay identical (设计稿: 激活态 = 浅色白卡描边 / 深色 #303137 底 + 蓝字). */
function menuRowClass(active: boolean): string {
	return cn(
		FOCUS_RING,
		"flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
		active
			? "border border-border bg-surface font-medium text-accent dark:bg-surface-3"
			: "border border-transparent text-fg hover:bg-surface-2 dark:hover:bg-surface-3",
	);
}

export default function Layout({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	workspaces,
	sessions,
	viewingSessionId,
	onSelectWorkspace,
	onSelectSession,
	onNewSessionInWorkspace,
	onNewWorkspace,
	onNewChat,
	onDeleteWorkspace,
	streamingCwds,
	switchingWorkspace,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	workspaces?: WorkspaceMeta[];
	/** 跨工作区会话摘要(含主对话工作区),映射到所属项目下。 */
	sessions?: SidebarSessionInfo[];
	/** 查看中的历史会话:选中态优先跟随它(查看模式不改活跃位,只看
	 *  state.sessionId 高亮永远不会动)。null/等于活跃会话 = 跟随活跃对话。 */
	viewingSessionId?: string | null;
	onSelectWorkspace?: (cwd: string) => void;
	onSelectSession?: (cwd: string, sessionId: string) => void;
	/** 项目行「+」:切到该项目工作区并开启全新会话。 */ 	onNewSessionInWorkspace?: (cwd: string) => void;
	onNewWorkspace?: () => void;
	onNewChat?: () => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	streamingCwds?: Set<string>;
	/** 正在切换到的目标工作区:切换期间立即高亮目标行,给出点击生效的反馈。 */
	switchingWorkspace?: string | null;
}) {
	const { t } = useTranslation();
	const online = sidecarReady && sidecarExitCode === null;
	// 选中态全局单选:项目/对话行仅在对话路由下高亮;在任务看板、配置等
	// 菜单页时由 NavLink 按路由高亮,工作区行不再保持选中。
	const onChatRoute = useLocation().pathname === "/chat";
	// 高亮跟随「目标」工作区:切换期间立即亮目标行,而不是等到 init 完成。
	const effectiveWorkspace = switchingWorkspace ?? workspace;
	const isMainChat = onChatRoute && isMainChatCwd(effectiveWorkspace);
	const [pinned, setPinned] = useState<Set<string>>(getPinnedWorkspaces);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const [projectsOpen, setProjectsOpen] = useState(true);
	const [chatsOpen, setChatsOpen] = useState(true);
	const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
	// 项目组搜索(设计稿项目组头部的放大镜图标):按项目名过滤工作区列表。
	const [projectSearchOpen, setProjectSearchOpen] = useState(false);
	const [projectQuery, setProjectQuery] = useState("");
	// 项目排序(设计稿项目组头部的筛选图标):最近访问 / 按名称。
	const [sortOpen, setSortOpen] = useState(false);
	const [sortMode, setSortMode] = useState<"recent" | "name">("recent");
	const sortMenuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!sortOpen) return;
		function handleMouseDown(e: MouseEvent) {
			if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
				setSortOpen(false);
			}
		}
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [sortOpen]);
	// 展开了会话子列表的工作区(按 workspace_id),以及切换到「显示全部会话」的工作区。
	const [sessionsOpenWs, setSessionsOpenWs] = useState<Set<string>>(new Set());
	const [sessionsFullWs, setSessionsFullWs] = useState<Set<string>>(new Set());
	const [collapsed, setCollapsed] = useState<boolean>(() => {
		try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
	});
	const [hovered, setHovered] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
			return next;
		});
	}, []);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
	}, []);

	const showSidebar = !collapsed || hovered;
	const floating = collapsed && hovered;

	const togglePin = useCallback((ws: WorkspaceMeta) => {
		setPinned((prev) => {
			const next = new Set(prev);
			if (next.has(ws.workspace_id)) {
				next.delete(ws.workspace_id);
			} else {
				next.add(ws.workspace_id);
			}
			setPinnedWorkspaces(next);
			return next;
		});
	}, []);

	const handleDelete = useCallback(async (ws: WorkspaceMeta) => {
		const name = basename(ws.cwd);
		if (!confirm(t("layout.deleteWorkspaceConfirm", { name }))) return;
		try {
			await deleteWorkspace(ws.workspace_id);
			onDeleteWorkspace?.(ws.workspace_id);
		} catch (e) {
			console.error("[workspace] delete error:", e);
			alert(t("layout.deleteWorkspaceFailed", { error: e instanceof Error ? e.message : String(e) }));
		}
	}, [onDeleteWorkspace, t]);

	const sortedWorkspaces = workspaces
		? [...workspaces].sort((a, b) => {
				const aPinned = pinned.has(a.workspace_id);
				const bPinned = pinned.has(b.workspace_id);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				if (sortMode === "name") {
					return basename(a.cwd).localeCompare(basename(b.cwd), undefined, { sensitivity: "base" });
				}
				return b.last_accessed_at - a.last_accessed_at;
			})
		: [];
	const projectQueryLower = projectQuery.trim().toLowerCase();
	const filteredWorkspaces = projectQueryLower
		? sortedWorkspaces.filter((ws) => basename(ws.cwd).toLowerCase().includes(projectQueryLower))
		: sortedWorkspaces;
	const visibleWorkspaces = showAllWorkspaces
		? filteredWorkspaces
		: filteredWorkspaces.slice(0, WORKSPACE_PREVIEW_COUNT);

	// ---- 会话 → 工作区映射(含主对话工作区,主会话也挂在「本地任务」下) ----
	const sessionsByWs = useMemo(() => {
		const map = new Map<string, SidebarSessionInfo[]>();
		for (const s of sessions ?? []) {
			const list = map.get(s.workspace_id);
			if (list) list.push(s);
			else map.set(s.workspace_id, [s]);
		}
		return map;
	}, [sessions]);
	const mainWorkspaceId = useMemo(
		() => (sessions ?? []).find((s) => isMainChatCwd(s.cwd))?.workspace_id,
		[sessions],
	);

	const toggleSessionsOpen = useCallback((workspaceId: string) => {
		setSessionsOpenWs((prev) => {
			const next = new Set(prev);
			if (next.has(workspaceId)) next.delete(workspaceId);
			else next.add(workspaceId);
			return next;
		});
	}, []);

	/** 某工作区当前应显示的会话子行(折叠时只留前 N 条)。 */
	const shownSessions = useCallback(
		(workspaceId: string): SidebarSessionInfo[] => {
			const list = sessionsByWs.get(workspaceId) ?? [];
			if (sessionsFullWs.has(workspaceId) || list.length <= SESSIONS_PREVIEW_COUNT) return list;
			return list.slice(0, SESSIONS_PREVIEW_COUNT);
		},
		[sessionsByWs, sessionsFullWs],
	);

	/** 渲染一个工作区行下的会话子列表(项目行与「本地任务」共用)。 */
	const renderSessionRows = (workspaceId: string, wsCwd?: string) => {
		const list = shownSessions(workspaceId);
		if (list.length === 0) {
			return (
				<p className="ml-8 px-2 py-1 text-[11px] text-muted">{t("layout.noSessions")}</p>
			);
		}
		const total = (sessionsByWs.get(workspaceId) ?? []).length;
		return (
			<div className="space-y-0.5 pb-1">
				{list.map((s) => {
					const active =
						(viewingSessionId ?? state?.sessionId) === s.session_id &&
						(wsCwd
							? // 主对话工作区的 wsCwd 是 ~ 路径,而 effectiveWorkspace 是展开后的绝对路径,
							  // samePath 精确比较永远不等 → 对话分组选中行此前从不高亮,这里特判。
							  samePath(effectiveWorkspace, wsCwd) ||
							  (wsCwd === MAIN_CHAT_CWD && isMainChatCwd(effectiveWorkspace))
							: false);
					return (
						<SessionRow
							key={s.session_id}
							session={s}
							active={active}
							onClick={() => onSelectSession?.(s.cwd, s.session_id)}
						/>
					);
				})}
				{total > list.length && (
					<button
						type="button"
						onClick={() =>
							setSessionsFullWs((prev) => new Set(prev).add(workspaceId))
						}
						className={cn(FOCUS_RING, "ml-8 rounded px-1 py-0.5 text-left text-[11px] text-muted transition-colors hover:text-accent")}
					>
						{t("layout.moreSessions", { count: total - list.length })}
					</button>
				)}
			</div>
		);
	};

	return (
		<div className="relative flex h-full bg-bg">
			{/* Expand button — shown only while collapsed, sits in the title bar just right of the macOS traffic lights */}
			{!showSidebar && (
				<button
					type="button"
					onClick={toggleCollapsed}
					className={cn(FOCUS_RING, "fixed left-[76px] top-[6px] z-50 flex h-8 w-8 items-center justify-center rounded-lg text-muted/50 transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-2")}
					title={t("layout.showSidebar")}
					aria-label={t("layout.showSidebar")}
				>
					<PanelLeft className="h-4 w-4" aria-hidden="true" />
				</button>
			)}

			{/* Left-edge hover strip: reveals the sidebar as a floating overlay while collapsed */}
			{collapsed && (
				<div
					className="fixed inset-y-0 left-0 z-30 w-2"
					onMouseEnter={() => { clearHoverTimer(); setHovered(true); }}
				/>
			)}
			<aside
				onMouseEnter={() => { clearHoverTimer(); if (collapsed) setHovered(true); }}
				onMouseLeave={() => { if (collapsed) { clearHoverTimer(); hoverTimerRef.current = setTimeout(() => setHovered(false), 150); } }}
				className={cn(
					"flex w-60 flex-col border-r border-border bg-bg transition-[width,transform,opacity] duration-150",
					floating ? "absolute inset-y-0 left-0 z-40 shadow-2xl" : "",
					!showSidebar ? "pointer-events-none w-0 -translate-x-full overflow-hidden opacity-0" : "",
				)}
			>
				{/* Brand + 状态点 + 隐藏侧栏按钮 (设计稿: 顶行直接从 logo 开始, 40px logo, y=20) */}
				<div
					data-tauri-drag-region
					className="flex items-center gap-3.5 px-4 pb-4 pt-5"
				>
					<img
						src="/ui/logo/top.png"
						alt=""
						draggable={false}
						className="h-10 w-10 shrink-0 select-none"
					/>
					<div className="min-w-0 flex-1 leading-tight" data-tauri-drag-region>
						<div
							data-tauri-drag-region
							className="truncate text-sm font-bold uppercase tracking-wide text-fg"
						>
							ZHarness
						</div>
						<div
							data-tauri-drag-region
							className="truncate text-[11px] text-muted"
						>
							{t("layout.brandTagline")}
						</div>
					</div>
					{/* Compact sidecar status: green online / pulsing blue streaming / red offline */}
					<span role="status" aria-label={online ? (state?.isStreaming ? t("layout.statusRunning") : t("layout.statusOnline")) : t("layout.statusOffline")} title={online ? (state?.isStreaming ? t("layout.statusRunning") : t("layout.statusOnline")) : t("layout.statusOffline")}>
						{online && state?.isStreaming ? (
							<span className="block h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
						) : (
							<StatusDot tone={online ? "success" : "danger"} />
						)}
					</span>
					<button
						data-no-drag
						type="button"
						onClick={toggleCollapsed}
						className={cn(FOCUS_RING, "flex h-8 w-8 items-center justify-center rounded-lg text-muted/60 transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-2")}
						title={t("layout.hideSidebar")}
						aria-label={t("layout.hideSidebar")}
					>
						<PanelLeft className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>

			{/* Primary nav: 聊天助手 / 专家·技能·连接器 / 定时任务。
			    任务看板先隐藏(入口移除,页面保留在 /board 路由,需要时恢复)。
			    图标全部使用设计师切图的「默认 / 选中」两态 PNG。 */}
			<nav className="space-y-0.5 px-3">
				{/* 聊天助手 = 主对话工作区(~/.zharness/main)的会话入口,复用 /chat 路由。
					    行尾 + 号 = 在该工作区开新会话(独立按钮,绝对定位叠加,避免 button 嵌套);
					    其历史会话在下方「对话」分组展示。 */}
					<div className="group relative">
						<button
							type="button"
							onClick={() => onSelectWorkspace?.(MAIN_CHAT_CWD)}
							className={menuRowClass(isMainChat)}
							title={t("layout.chatTitle")}
						>
							<ToggleIcon
								defaultSrc="/ui/sidebar/local-tasks.png"
								activeSrc="/ui/sidebar/local-tasks-active.png"
								alt=""
								active={isMainChat}
								size={18}
							/>
							<span className="truncate">{t("layout.localTasks")}</span>
						</button>
						<button
							type="button"
							title={t("layout.newChat")}
							aria-label={t("layout.newChat")}
							onClick={(e) => {
								e.stopPropagation();
								onNewChat?.();
							}}
							className={cn(FOCUS_RING, "absolute right-2 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-accent group-hover:flex group-focus-within:flex")}
						>
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
					</div>
					<NavLink to="/config" className={({ isActive }) => menuRowClass(isActive)}>
						{({ isActive }) => (
							<>
								<ToggleIcon
									defaultSrc="/ui/sidebar/config.png"
									activeSrc="/ui/sidebar/config-active.png"
									alt=""
									active={isActive}
									size={18}
								/>
								<span className="truncate">{t("layout.config")}</span>
							</>
						)}
					</NavLink>
					{/* 定时任务 = 复用自动化任务页(/tasks) */}
					<NavLink to="/tasks" className={({ isActive }) => menuRowClass(isActive)}>
						{({ isActive }) => (
							<>
								<ToggleIcon
									defaultSrc="/ui/sidebar/scheduled.png"
									activeSrc="/ui/sidebar/scheduled-active.png"
									alt=""
									active={isActive}
									size={18}
								/>
								<span className="truncate">{t("layout.scheduledTasks")}</span>
							</>
						)}
					</NavLink>
				</nav>

				{/* 项目 / 对话 groups */}
				<div className="mt-3 flex-1 overflow-y-auto px-3 pb-2">
				{/* 项目 group (设计稿: 标题行右侧 搜索 / 筛选 / 新建 三个图标) */}
				<div className="mb-1 flex items-center justify-between px-1">
					<button
						type="button"
						onClick={() => setProjectsOpen((v) => !v)}
						aria-expanded={projectsOpen}
						className={cn(FOCUS_RING, "flex items-center gap-1 rounded text-xs text-muted transition-colors hover:text-fg")}
					>
						<span>{t("layout.projects")}</span>
						<ChevronDown className={cn("h-3 w-3 transition-transform", !projectsOpen && "-rotate-90")} aria-hidden="true" />
					</button>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => {
								setProjectSearchOpen((v) => {
									if (v) setProjectQuery("");
									return !v;
								});
							}}
							aria-label={t("layout.searchProjects")}
							aria-pressed={projectSearchOpen}
							className={cn(FOCUS_RING, "flex h-5 w-5 items-center justify-center rounded transition-colors", projectSearchOpen ? "text-accent" : "text-muted hover:text-accent")}
						>
							<UiImg src="/ui/action/search.png" size={13} />
						</button>
						<div className="relative">
							<button
								type="button"
								onClick={() => setSortOpen((v) => !v)}
								aria-label={t("layout.sortProjects")}
								aria-haspopup="menu"
								aria-expanded={sortOpen}
								className={cn(FOCUS_RING, "flex h-5 w-5 items-center justify-center rounded transition-colors", sortOpen ? "text-accent" : "text-muted hover:text-accent")}
							>
								<ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
							{sortOpen && (
								<div ref={sortMenuRef} role="menu" className="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-border bg-surface py-1 shadow-lg">
									<button
										type="button"
										role="menuitemradio"
										aria-checked={sortMode === "recent"}
										onClick={() => { setSortMode("recent"); setSortOpen(false); }}
										className={cn(FOCUS_RING, "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-fg transition-colors hover:bg-accent/10 hover:text-accent")}
									>
										<Check className={cn("h-3 w-3 shrink-0", sortMode === "recent" ? "text-accent" : "opacity-0")} aria-hidden="true" />
										<span>{t("layout.sortRecent")}</span>
									</button>
									<button
										type="button"
										role="menuitemradio"
										aria-checked={sortMode === "name"}
										onClick={() => { setSortMode("name"); setSortOpen(false); }}
										className={cn(FOCUS_RING, "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-fg transition-colors hover:bg-accent/10 hover:text-accent")}
									>
										<Check className={cn("h-3 w-3 shrink-0", sortMode === "name" ? "text-accent" : "opacity-0")} aria-hidden="true" />
										<span>{t("layout.sortName")}</span>
									</button>
								</div>
							)}
						</div>
						<button
							type="button"
							onClick={() => onNewWorkspace?.()}
							disabled={!isTauri()}
							aria-label={t("layout.newWorkspaceTitle")}
							title={isTauri() ? t("layout.newWorkspaceTitle") : t("layout.newWorkspaceDesktopOnly")}
							className={cn(FOCUS_RING, "flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted")}
						>
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
					</div>
				</div>
				{projectSearchOpen && (
					<div className="mb-1 flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2 focus-within:ring-1 focus-within:ring-accent/50">
						<UiImg src="/ui/action/search.png" size={13} className="opacity-60" />
						<input
							autoFocus
							type="search"
							name="project-search"
							value={projectQuery}
							onChange={(e) => setProjectQuery(e.target.value)}
							placeholder={t("layout.searchProjectsPlaceholder")}
							aria-label={t("layout.searchProjects")}
							autoComplete="off"
							spellCheck={false}
							className="w-full bg-transparent text-xs text-fg placeholder:text-muted focus:outline-none [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
						/>
					</div>
				)}
					{projectsOpen && (
						<div className="space-y-0.5">
							{visibleWorkspaces.length > 0 ? visibleWorkspaces.map((ws) => {
								const isActive = onChatRoute && effectiveWorkspace === ws.cwd;
								const isPinned = pinned.has(ws.workspace_id);
								const isMenuOpen = menuOpenId === ws.workspace_id;
								const sessionsOpen = sessionsOpenWs.has(ws.workspace_id);
								return (
									<div key={ws.workspace_id}>
										<div className="group relative">
										{/* 行本体 = 真按钮:点击展开/收起所属会话列表;三角在左,「+」/更多操作为绝对定位的兄弟按钮,避免嵌套 button。 */}
										<button
											type="button"
											onClick={() => toggleSessionsOpen(ws.workspace_id)}
											aria-expanded={sessionsOpen}
											aria-label={sessionsOpen ? t("layout.hideSessions") : t("layout.showSessions")}
											className={cn(
												FOCUS_RING,
												"flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
												isActive
													? "border-border bg-surface dark:bg-surface-3"
													: "border-transparent hover:bg-surface-2 dark:hover:bg-surface-3",
											)}
											title={ws.cwd}
										>
											<ChevronDown
												aria-hidden="true"
												className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", sessionsOpen ? "" : "-rotate-90")}
											/>
												{isPinned ? (
													<Pin className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} aria-hidden="true" />
												) : (
													<Folder className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} aria-hidden="true" />
												)}
												<span className={cn("min-w-0 flex-1 truncate text-[13px]", isActive ? "font-medium text-accent" : "text-fg")}>
													{basename(ws.cwd)}
												</span>
											{online && (isActive || streamingCwds?.has(ws.cwd)) && (
												<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full group-hover:hidden group-focus-within:hidden", (isActive ? state?.isStreaming : true) ? "bg-accent animate-pulse motion-reduce:animate-none" : "bg-success")} />
											)}
											<span className="shrink-0 text-[11px] tabular-nums text-muted/80 group-hover:hidden group-focus-within:hidden">
												{timeAgo(ws.last_accessed_at, t)}
											</span>
										</button>
											<button
												type="button"
												title={t("layout.newChat")}
												aria-label={t("layout.newChat")}
												onClick={(e) => {
													e.stopPropagation();
													// 展开列表,让新会话出现在所属项目下。
													setSessionsOpenWs((prev) => new Set(prev).add(ws.workspace_id));
													onNewSessionInWorkspace?.(ws.cwd);
												}}
												className={cn(FOCUS_RING, "absolute right-7 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-accent group-hover:flex group-focus-within:flex")}
											>
												<Plus className="h-3.5 w-3.5" aria-hidden="true" />
											</button>
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													setMenuOpenId(isMenuOpen ? null : ws.workspace_id);
												}}
												aria-label={t("layout.moreActions")}
												aria-haspopup="menu"
												aria-expanded={isMenuOpen}
												className={cn(FOCUS_RING, "absolute right-1.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg group-hover:flex group-focus-within:flex")}
											>
												<MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
											</button>
											{isMenuOpen && (
												<WorkspaceMenu
													ws={ws}
													onPin={() => togglePin(ws)}
													isPinned={isPinned}
													onDelete={() => void handleDelete(ws)}
													onClose={() => setMenuOpenId(null)}
												/>
											)}
										</div>
										{/* 历史会话映射到所属项目下:点会话 = 切工作区 + 跳转会话。 */}
										{sessionsOpen && renderSessionRows(ws.workspace_id, ws.cwd)}
									</div>
								);
							}) : (
								<p className="px-2 py-3 text-center text-[11px] text-muted">{t("layout.noWorkspaces")}</p>
							)}
							{filteredWorkspaces.length > WORKSPACE_PREVIEW_COUNT && (
								<button
									type="button"
									onClick={() => setShowAllWorkspaces((v) => !v)}
									className={cn(FOCUS_RING, "w-full rounded px-2 py-1 text-left text-[11px] text-muted transition-colors hover:text-accent")}
								>
									{showAllWorkspaces ? t("layout.collapse") : t("layout.expandMore")}
								</button>
							)}
						</div>
					)}

					{/* 对话 group — 与项目平级:聊天助手(主对话工作区)的历史会话。 */}
					<div className="mb-1 mt-4 flex items-center justify-between px-1">
						<button
							type="button"
							onClick={() => setChatsOpen((v) => !v)}
							aria-expanded={chatsOpen}
							className={cn(FOCUS_RING, "flex items-center gap-1 rounded text-xs text-muted transition-colors hover:text-fg")}
						>
							<span>{t("layout.chats")}</span>
							<ChevronDown className={cn("h-3 w-3 transition-transform", !chatsOpen && "-rotate-90")} aria-hidden="true" />
						</button>
					</div>
					{chatsOpen && (
						<div className="space-y-0.5">
							{mainWorkspaceId
								? renderSessionRows(mainWorkspaceId, MAIN_CHAT_CWD)
								: <p className="px-2 py-3 text-center text-[11px] text-muted">{t("layout.noSessions")}</p>}
						</div>
					)}
				</div>

				{/* Persistent-agent identity card (SOUL.md + 用户长期记忆) */}
				<PersonaCard online={online} />

				{/* Bottom: 设置 + theme toggle */}
				<div className="border-t border-border px-3 py-2">
					<div className="flex items-center gap-1">
						<NavLink to="/settings" className={({ isActive }) => cn(menuRowClass(isActive), "flex-1")}>
							<SettingsIcon className="h-4 w-4 shrink-0" />
							<span className="truncate">{t("common.settings")}</span>
						</NavLink>
						<ThemeToggle />
					</div>
				</div>
			</aside>

			{/* 主内容区底色 = surface(设计稿: 浅 #FFFFFF / 深 #1A1A1F),侧栏为更凹陷的 bg */}
			<main className="min-w-0 flex-1 overflow-hidden bg-surface">
				<WorkspacePane workspace={workspace} ptyPort={state?.ptyPort}>
					<Outlet context={{ sidebarCollapsed: collapsed } satisfies LayoutOutletContext} />
				</WorkspacePane>
			</main>
		</div>
	);
}
