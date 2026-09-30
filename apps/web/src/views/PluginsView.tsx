import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
	fetchSkillsSh,
	getSkills,
	getExtensions,
	setExtensionEnabled,
	installExtension,
	uninstallExtension,
	installSkill,
	openExternal,
	getSopMarket,
	getSops,
	installSop,
	uninstallSop,
	type SkillsShSkill,
	type SkillInfo,
	type ExtensionInfo,
	type SopInfo,
	type SopMarketEntry,
} from "@/lib/transport";
import {
	Puzzle,
	BookOpen,
	Server,
	ExternalLink,
	Zap,
	Workflow,
	Play,
} from "lucide-react";
import { UiImg } from "@/components/UiImg";
import type { LayoutOutletContext } from "@/components/Layout";

type PluginTab = "skills" | "extensions" | "mcp" | "sops";

/** 设计稿顶部图卡式 tab: 设计师切的缩略图底纹 + 标签。激活态换用「蓝色渐变版」。
 * 无切图的 tab(如 SOP 市场)传空 bg,回退到 CSS 渐变,视觉与切图版保持一致。 */
function ThumbTab({
	active,
	label,
	bgDefault,
	bgActive,
	onClick,
}: {
	active: boolean;
	label: string;
	/** 设计稿切图: 默认态(灰底纹);无切图时传 undefined 用渐变回退 */
	bgDefault?: string;
	/** 设计稿切图: 选中态(蓝渐变底纹);无切图时传 undefined 用渐变回退 */
	bgActive?: string;
	onClick: () => void;
}) {
	const fallback =
		active
			? "linear-gradient(135deg, rgba(0,118,255,0.16), rgba(0,118,255,0.04))"
			: "linear-gradient(135deg, rgba(148,163,184,0.12), rgba(148,163,184,0.04))";
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative h-10 w-32 shrink-0 overflow-hidden rounded-lg border text-left transition-all",
				active
					? "border-[#7fc2ff]/70 shadow-sm dark:border-blue-400/50"
					: "border-border hover:border-muted/40",
			)}
			style={
				bgDefault && bgActive
					? {
							backgroundImage: `url(${active ? bgActive : bgDefault})`,
							backgroundSize: "cover",
							backgroundRepeat: "no-repeat",
						}
					: { backgroundImage: fallback }
			}
		>
			<span
				className={cn(
					"relative z-10 flex h-full items-center pl-3 text-sm font-medium",
					active ? "text-[#0076FF] dark:text-blue-300" : "text-muted",
				)}
			>
				{label}
			</span>
		</button>
	);
}

/** 技能/扩展条目左上角的图标块 — 设计稿: 浅蓝圆角方块 + 蓝色图标。 */
function EntryIcon({ children }: { children: React.ReactNode }) {
	return (
		<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
			{children}
		</span>
	);
}

/** 目录卡片 (技能/扩展共用骨架): 图标 + 名称 + 查看链接 + 顶部操作按钮 + 描述 + 底部信息区。 */
function DirectoryCard({
	icon,
	name,
	viewHref,
	description,
	footer,
	action,
}: {
	icon: React.ReactNode;
	name: string;
	viewHref?: string;
	description?: string;
	footer?: React.ReactNode;
	action?: React.ReactNode;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col rounded-xl border border-border bg-surface px-4 py-3.5 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-center gap-2.5">
				{icon}
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={name}>
					{name}
				</span>
			{viewHref ? (
				// window.open / <a target="_blank"> 是 no-op 且无响应,桌面端须经 shell 插件打开系统浏览器。
				<a
					href={viewHref}
					onClick={(e) => {
						e.preventDefault();
						void openExternal(viewHref);
					}}
					className="flex shrink-0 items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
				>
					<ExternalLink className="h-3 w-3" />
					{t("plugins.skills.view")}
				</a>
			) : (
					<span className="shrink-0 text-xs text-muted/50">{t("plugins.skills.view")}</span>
				)}
				{action}
			</div>
			{description && (
				<p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">{description}</p>
			)}
			{footer && (
				<div className="mt-3 flex items-center gap-2">{footer}</div>
			)}
		</div>
	);
}

/** 右侧「已安装列表」面板。 */
function InstalledPanel({ count, children }: { count: number; children: React.ReactNode }) {
	const { t } = useTranslation();
	return (
		<aside className="w-72 shrink-0 rounded-xl border border-border bg-surface px-4 py-3.5 shadow-sm">
			<h2 className="mb-3 text-sm font-semibold text-fg">
				{t("plugins.installedList")} ({count})
			</h2>
			<div className="space-y-3">{children}</div>
		</aside>
	);
}

function InstalledSkillCard({ skill }: { skill: SkillInfo }) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-border px-3 py-2.5">
			<div className="flex items-center gap-2">
				<EntryIcon>
					<Zap className="h-4 w-4" />
				</EntryIcon>
				<span className="min-w-0 flex-1 truncate text-xs font-medium text-fg" title={skill.name}>
					{skill.name}
				</span>
				<Badge tone="success">{t("plugins.skills.installed")}</Badge>
			</div>
			{skill.description && (
				<p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted">{skill.description}</p>
			)}
			<code className="mt-1.5 block truncate font-mono text-[10px] text-muted/70">{skill.command}</code>
		</div>
	);
}

function SkillsTab({ search }: { search: string }) {
	const { t } = useTranslation();
	const [dirSkills, setDirSkills] = useState<SkillsShSkill[]>([]);
	const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [installingId, setInstallingId] = useState<string | null>(null);
	const [installError, setInstallError] = useState("");

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			// Load both in parallel — local skills may fail if sidecar is down
			const [dir, local] = await Promise.allSettled([
				fetchSkillsSh(),
				getSkills(),
			]);
			if (dir.status === "fulfilled") setDirSkills(dir.value);
			if (local.status === "fulfilled") setInstalledSkills(local.value);
			if (dir.status === "rejected" && local.status === "rejected") {
				setError(dir.reason instanceof Error ? dir.reason.message : String(dir.reason));
			}
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	/**
	 * 安装按钮此前只 window.open 打开 skills.sh 页面,桌面端 WebView 下是 no-op,
	 * 点击毫无反应。这里改为真正安装:GitHub 来源(owner/repo)走 install_skill
	 * RPC(git clone → 拷贝 SKILL.md 到 <agentDir>/skills/<slug> → sidecar 重载
	 * 资源),其他来源(如 site/open.feishu.cn 这类非 GitHub 技能)退回打开技能页面。
	 */
	const handleInstall = useCallback(
		async (skill: SkillsShSkill) => {
			if (installingId) return;
			const isGithubSource =
				/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.source) &&
				!skill.source.startsWith("site/");
			if (!isGithubSource) {
				void openExternal(skill.url);
				return;
			}
			setInstallingId(skill.id);
			setInstallError("");
			try {
				const result = await installSkill(skill.source, skill.slug);
				if (!result.ok) {
					setInstallError(result.message);
					return;
				}
			} catch (e) {
				setInstallError(e instanceof Error ? e.message : String(e));
				return;
			} finally {
				setInstallingId(null);
			}
			// install_skill 成功后 sidecar 已 reload 资源,重新拉取已安装列表。
			try {
				setInstalledSkills(await getSkills());
			} catch { /* 保留旧列表 */ }
		},
		[installingId],
	);

	const installedNames = new Set(installedSkills.map((s) => s.name));
	const query = search.trim().toLowerCase();
	const filteredDir = query
		? dirSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(query) ||
					s.source.toLowerCase().includes(query) ||
					s.slug.toLowerCase().includes(query),
			)
		: dirSkills;
	const filteredLocal = query
		? installedSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(query) ||
					s.description?.toLowerCase().includes(query),
			)
		: installedSkills;

	if (loading) {
		return <p className="py-10 text-center text-sm text-muted">{t("plugins.loading")}</p>;
	}
	if (error) {
		return <p className="py-10 text-center text-sm text-danger">{t("plugins.error", { error })}</p>;
	}

	return (
		<div className="flex items-start gap-4">
			<div className="min-w-0 flex-1">
				{installError && (
					<p className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
						{installError}
					</p>
				)}
				{filteredDir.length === 0 ? (
					<EmptyState
						icon={<BookOpen className="h-10 w-10" />}
						title={t("plugins.skills.empty")}
						description={t("plugins.skills.emptyHint")}
					/>
				) : (
					<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
						{filteredDir.map((skill) => {
							const installed = installedNames.has(skill.slug);
							return (
								<DirectoryCard
								key={skill.id}
								icon={
									<EntryIcon>
										<Zap className="h-4 w-4" />
									</EntryIcon>
								}
								name={skill.name}
								viewHref={skill.url}
								description={skill.source}
							action={
								installed ? (
									<Badge tone="success">{t("plugins.skills.installed")}</Badge>
								) : installingId === skill.id ? (
									<Badge tone="warning">{t("plugins.skills.installing")}</Badge>
								) : (
									<Button
										size="sm"
										tone="accent"
										variant="soft"
										iconLeft={<UiImg src="/ui/action/install.png" size={14} />}
										onClick={() => void handleInstall(skill)}
										title={t("plugins.skills.install")}
									>
										{t("plugins.skills.install")}
									</Button>
								)
							}
							/>
							);
						})}
					</div>
				)}
			</div>
			<InstalledPanel count={filteredLocal.length}>
				{filteredLocal.length > 0 ? (
					filteredLocal.map((skill) => <InstalledSkillCard key={skill.command} skill={skill} />)
				) : (
					<p className="py-4 text-center text-[11px] text-muted">{t("plugins.skills.empty")}</p>
				)}
			</InstalledPanel>
		</div>
	);
}

function ExtensionCard({
	ext,
	onInstall,
	onUninstall,
	busyId,
}: {
	ext: ExtensionInfo;
	onInstall: (id: string) => void;
	onUninstall: (id: string) => void;
	busyId: string | null;
}) {
	const { t } = useTranslation();
	const busy = busyId === ext.id;
	// Enable/disable lives on the installed panel card, keeping the directory
	// card actions to a single button per the design.

	return (
		<DirectoryCard
			icon={
				<EntryIcon>
					<Puzzle className="h-4 w-4" />
				</EntryIcon>
			}
			name={ext.name}
			description={ext.description}
			footer={
				<>
					<Badge tone="neutral">{t(`plugins.extensions.${ext.kind}`)}</Badge>
					{ext.toolCount > 0 && (
						<span className="text-[11px] text-muted">
							{t("plugins.extensions.tools", { count: ext.toolCount })}
						</span>
					)}
					{ext.commandCount > 0 && (
						<span className="text-[11px] text-muted">
							{t("plugins.extensions.commands", { count: ext.commandCount })}
						</span>
					)}
				</>
			}
			action={
				busy ? (
					<Badge tone="warning">{t("plugins.extensions.installing")}</Badge>
				) : (
					ext.installable && (
						<Button
							size="sm"
							tone={ext.installed ? "danger" : "accent"}
							variant="soft"
							disabled={busy}
							onClick={() => (ext.installed ? onUninstall(ext.id) : onInstall(ext.id))}
							title={ext.installed ? t("plugins.extensions.uninstall") : t("plugins.extensions.install")}
							iconLeft={<UiImg src={ext.installed ? "/ui/action/uninstall.png" : "/ui/action/install.png"} size={14} />}
						>
							{ext.installed ? t("plugins.extensions.uninstall") : t("plugins.extensions.install")}
						</Button>
					)
				)
			}
		/>
	);
}

function ExtensionsTab({ search, onRestartSidecar }: { search: string; onRestartSidecar?: () => Promise<void> }) {
	const { t } = useTranslation();
	const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [reloadHint, setReloadHint] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			const exts = await getExtensions();
			setExtensions(exts);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleToggle = useCallback(
		async (id: string, enabled: boolean) => {
			const requiresReload = await setExtensionEnabled(id, enabled);
			// Optimistically flip the local state; a full refresh re-syncs with the agent.
			setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, enabled } : e)));
			// 启用/禁用写的是 settings.disabledBuiltinExtensions,当前 sidecar 里
			// 已加载的扩展不会自行卸载——重启 sidecar 让设置立即生效,而不是只
			// 挂一条"重载后生效"的提示然后什么都不做。
			if (requiresReload) {
				try {
					await onRestartSidecar?.();
					await refresh();
				} catch (e) {
					console.error("[plugins] restart after toggle failed:", e);
					setReloadHint(true);
				}
			}
		},
		[onRestartSidecar, refresh],
	);

	const [busyId, setBusyId] = useState<string | null>(null);
	const [installMessage, setInstallMessage] = useState<string | null>(null);
	// Synchronous guard so rapid double-clicks can't bypass the busyId state update.
	const lifecycleLock = useRef<string | null>(null);

	const runLifecycle = useCallback(
		async (id: string, fn: (id: string) => Promise<{ ok: boolean; message: string; installed: boolean }>) => {
			if (lifecycleLock.current) return;
			lifecycleLock.current = id;
			setBusyId(id);
			setInstallMessage(null);
			try {
				const result = await fn(id);
				setInstallMessage(result.message);
				if (result.ok) {
					// Re-sync with the agent: install/uninstall may change tool/command counts,
					// enabled state, or other fields beyond just `installed`.
					await refresh();
				} else {
					// On failure, only update the install flag locally.
					setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, installed: result.installed } : e)));
				}
			} catch (e) {
				setInstallMessage(e instanceof Error ? e.message : String(e));
			} finally {
				lifecycleLock.current = null;
				setBusyId(null);
			}
		},
		[refresh],
	);

	const handleInstall = useCallback((id: string) => runLifecycle(id, installExtension), [runLifecycle]);
	const handleUninstall = useCallback((id: string) => runLifecycle(id, uninstallExtension), [runLifecycle]);

	const query = search.trim().toLowerCase();
	const filtered = query
		? extensions.filter(
				(e) =>
					e.name.toLowerCase().includes(query) ||
					e.description?.toLowerCase().includes(query),
			)
		: extensions;
	// 已安装列表: 不可卸载的内置扩展始终可用;可安装/卸载的条目(如 agent-browser
	// 这类带外部依赖的内置扩展,以及 CLI 扩展)以 installed 标志为准——卸载成功后
	// 立即从列表移除,而不是因为 kind === "builtin" 永远挂在列表里。
	const installed = filtered.filter((e) => (e.installable ? e.installed : e.kind === "builtin" || e.installed));

	if (loading) {
		return <p className="py-10 text-center text-sm text-muted">{t("plugins.loading")}</p>;
	}
	if (error) {
		return <p className="py-10 text-center text-sm text-danger">{t("plugins.error", { error })}</p>;
	}

	return (
		<div className="flex items-start gap-4">
			<div className="min-w-0 flex-1 space-y-3">
				{reloadHint && (
					<p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
						{t("plugins.extensions.reloadHint")}
					</p>
				)}
				{installMessage && (
					<p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
						{installMessage}
					</p>
				)}
				{filtered.length === 0 ? (
					<EmptyState
						icon={<Puzzle className="h-10 w-10" />}
						title={t("plugins.extensions.empty")}
					/>
				) : (
					<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
						{filtered.map((ext) => (
							<ExtensionCard
								key={ext.id}
								ext={ext}
								onInstall={handleInstall}
								onUninstall={handleUninstall}
								busyId={busyId}
							/>
						))}
					</div>
				)}
			</div>
			<InstalledPanel count={installed.length}>
				{installed.length > 0 ? (
					installed.map((ext) => (
						<div key={ext.id} className="rounded-lg border border-border px-3 py-2.5">
							<div className="flex items-center gap-2">
								<EntryIcon>
									<Puzzle className="h-4 w-4" />
								</EntryIcon>
								<span className="min-w-0 flex-1 truncate text-xs font-medium text-fg" title={ext.name}>
									{ext.name}
								</span>
								{ext.canToggle && (
									<Button
										size="sm"
										tone={ext.enabled ? "success" : "neutral"}
										variant="soft"
										disabled={busyId === ext.id}
										onClick={() => handleToggle(ext.id, !ext.enabled)}
										title={ext.enabled ? t("plugins.extensions.disable") : t("plugins.extensions.enable")}
										iconLeft={<UiImg src={ext.enabled ? "/ui/action/disable.png" : "/ui/action/enable.png"} size={12} />}
									>
										{ext.enabled ? t("plugins.extensions.disable") : t("plugins.extensions.enable")}
									</Button>
								)}
								{ext.installable && (
									<Button
										size="sm"
										tone="danger"
										variant="soft"
										loading={busyId === ext.id}
										disabled={busyId === ext.id}
										onClick={() => handleUninstall(ext.id)}
										iconLeft={<UiImg src="/ui/action/uninstall.png" size={12} />}
									>
										{t("plugins.extensions.uninstall")}
									</Button>
								)}
							</div>
							{ext.description && (
								<p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted">{ext.description}</p>
							)}
							<div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted/70">
								<span>{t(`plugins.extensions.${ext.kind}`)}</span>
								{ext.toolCount > 0 && <span>{t("plugins.extensions.tools", { count: ext.toolCount })}</span>}
								{ext.commandCount > 0 && <span>{t("plugins.extensions.commands", { count: ext.commandCount })}</span>}
							</div>
						</div>
					))
				) : (
					<p className="py-4 text-center text-[11px] text-muted">{t("plugins.extensions.empty")}</p>
				)}
			</InstalledPanel>
		</div>
	);
}

/** SOP 市场标签页:市场目录(内置 + GitHub 来源) + 已安装面板(运行/卸载)。
 * 运行走 /sop run 命令(由 App 跳回当前工作区对话页发送)。 */
function SopsTab({
	search,
	onRunSop,
}: {
	search: string;
	onRunSop?: (slug: string) => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const [market, setMarket] = useState<SopMarketEntry[]>([]);
	const [installed, setInstalled] = useState<SopInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);
	const [message, setMessage] = useState("");

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			const [entries, sops] = await Promise.all([getSopMarket(), getSops()]);
			setMarket(entries);
			setInstalled(sops);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleInstall = useCallback(
		async (entry: SopMarketEntry) => {
			if (busyId) return;
			setBusyId(entry.slug);
			setMessage("");
			try {
				const result = await installSop(entry.source === "builtin" ? "builtin" : entry.source.replace(/^github:/, ""), entry.slug);
				setMessage(result.message);
				if (result.ok) await refresh();
			} catch (e) {
				setMessage(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[busyId, refresh],
	);

	const handleUninstall = useCallback(
		async (slug: string) => {
			if (busyId) return;
			setBusyId(slug);
			setMessage("");
			try {
				const result = await uninstallSop(slug);
				setMessage(result.message);
				if (result.ok) await refresh();
			} catch (e) {
				setMessage(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[busyId, refresh],
	);

	const handleRun = useCallback(
		async (slug: string) => {
			await onRunSop?.(slug);
		},
		[onRunSop],
	);

	// 从 GitHub 安装:owner/repo 里的 <slug>/SOP.md(与技能市场同协议)。
	const [ghSource, setGhSource] = useState("");
	const [ghSlug, setGhSlug] = useState("");
	const ghSourceValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ghSource.trim());
	const ghSlugValid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ghSlug.trim());
	const handleInstallFromGithub = useCallback(async () => {
		if (busyId || !ghSourceValid || !ghSlugValid) return;
		setBusyId(ghSlug.trim());
		setMessage("");
		try {
			const result = await installSop(ghSource.trim(), ghSlug.trim());
			setMessage(result.message);
			if (result.ok) {
				setGhSource("");
				setGhSlug("");
				await refresh();
			}
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	}, [busyId, ghSource, ghSlug, ghSourceValid, ghSlugValid, refresh]);

	const query = search.trim().toLowerCase();
	const filteredMarket = query
		? market.filter(
				(e) =>
					e.name.toLowerCase().includes(query) ||
					e.slug.toLowerCase().includes(query) ||
					e.description?.toLowerCase().includes(query) ||
					e.tags.some((tag) => tag.toLowerCase().includes(query)),
			)
		: market;
	const filteredInstalled = query
		? installed.filter(
				(s) =>
					s.name.toLowerCase().includes(query) ||
					s.slug.toLowerCase().includes(query) ||
					s.description?.toLowerCase().includes(query),
			)
		: installed;

	if (loading) {
		return <p className="py-10 text-center text-sm text-muted">{t("plugins.loading")}</p>;
	}
	if (error) {
		return <p className="py-10 text-center text-sm text-danger">{t("plugins.error", { error })}</p>;
	}

	return (
		<div className="flex items-start gap-4">
			<div className="min-w-0 flex-1 space-y-3">
				{message && (
					<p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">{message}</p>
				)}
				{/* 从 GitHub 安装:owner/repo + slug 两个输入 + 安装按钮 */}
				<div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-sm">
					<EntryIcon>
						<Workflow className="h-4 w-4" />
					</EntryIcon>
					<input
						value={ghSource}
						onChange={(e) => setGhSource(e.target.value)}
						placeholder={t("plugins.sops.ghSourcePlaceholder")}
						className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2.5 text-sm text-fg placeholder:text-muted focus:outline-none"
					/>
					<span className="shrink-0 text-xs text-muted">/</span>
					<input
						value={ghSlug}
						onChange={(e) => setGhSlug(e.target.value)}
						placeholder={t("plugins.sops.ghSlugPlaceholder")}
						className="h-8 w-40 shrink-0 rounded-md border border-border bg-surface-2 px-2.5 text-sm text-fg placeholder:text-muted focus:outline-none"
					/>
					<Button
						size="sm"
						tone="accent"
						variant="soft"
						disabled={busyId !== null || !ghSourceValid || !ghSlugValid}
						onClick={() => void handleInstallFromGithub()}
						title={t("plugins.sops.installFromGithubHint")}
					>
						{busyId !== null ? t("plugins.sops.installing") : t("plugins.sops.installFromGithub")}
					</Button>
				</div>
				{filteredMarket.length === 0 ? (
					<EmptyState
						icon={<Workflow className="h-10 w-10" />}
						title={t("plugins.sops.empty")}
						description={t("plugins.sops.emptyHint")}
					/>
				) : (
					<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
						{filteredMarket.map((entry) => (
							<DirectoryCard
								key={`${entry.source}/${entry.slug}`}
								icon={
									<EntryIcon>
										<Workflow className="h-4 w-4" />
									</EntryIcon>
								}
								name={entry.name}
								description={entry.description}
								footer={
									<>
										<Badge tone="neutral">
											{entry.source === "builtin" ? t("plugins.sops.builtinSource") : t("plugins.sops.githubSource")}
										</Badge>
										{entry.kind === "dynamic" && <Badge tone="accent">{t("plugins.sops.dynamic")}</Badge>}
										{entry.kind !== "dynamic" && (
											<span className="text-[11px] text-muted">
												{t("plugins.sops.steps", { count: entry.stepCount })}
											</span>
										)}
										{entry.version && <span className="text-[11px] text-muted/70">v{entry.version}</span>}
									</>
								}
								action={
									entry.installed ? (
										<Badge tone="success">{t("plugins.sops.installed")}</Badge>
									) : busyId === entry.slug ? (
										<Badge tone="warning">{t("plugins.sops.installing")}</Badge>
									) : (
										<Button
											size="sm"
											tone="accent"
											variant="soft"
											iconLeft={<UiImg src="/ui/action/install.png" size={14} />}
											onClick={() => void handleInstall(entry)}
											title={t("plugins.sops.install")}
										>
											{t("plugins.sops.install")}
										</Button>
									)
								}
							/>
						))}
					</div>
				)}
			</div>
			<InstalledPanel count={filteredInstalled.length}>
				{filteredInstalled.length > 0 ? (
					filteredInstalled.map((sop) => (
						<div key={sop.slug} className="rounded-lg border border-border px-3 py-2.5">
							<div className="flex items-center gap-2">
								<EntryIcon>
									<Workflow className="h-4 w-4" />
								</EntryIcon>
								<span className="min-w-0 flex-1 truncate text-xs font-medium text-fg" title={sop.name}>
									{sop.name}
								</span>
								<Button
									size="sm"
									tone="accent"
									variant="soft"
									disabled={busyId === sop.slug}
									onClick={() => void handleRun(sop.slug)}
									title={t("plugins.sops.runHint")}
									iconLeft={<Play className="h-3 w-3" />}
								>
									{t("plugins.sops.run")}
								</Button>
								<Button
									size="sm"
									tone="danger"
									variant="soft"
									loading={busyId === sop.slug}
									disabled={busyId === sop.slug}
									onClick={() => void handleUninstall(sop.slug)}
									iconLeft={<UiImg src="/ui/action/uninstall.png" size={12} />}
									title={t("plugins.sops.uninstall")}
								>
									{t("plugins.sops.uninstall")}
								</Button>
							</div>
							{sop.description && (
								<p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted">{sop.description}</p>
							)}
							<div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted/70">
									{sop.kind === "dynamic" ? (
										<Badge tone="accent">{t("plugins.sops.dynamic")}</Badge>
									) : (
										<span>{t("plugins.sops.steps", { count: sop.stepCount })}</span>
									)}
									{sop.args.length > 0 && (
										<span>
											{t("plugins.sops.argsLabel")}: {sop.args.map((a) => (a.required ? `${a.name}*` : a.name)).join(", ")}
										</span>
									)}
									<code className="truncate font-mono">/sop run {sop.slug}</code>
								</div>
						</div>
					))
				) : (
					<p className="py-4 text-center text-[11px] text-muted">{t("plugins.sops.empty")}</p>
				)}
			</InstalledPanel>
		</div>
	);
}

export default function PluginsView({
	onRestartSidecar,
	onRunSop,
}: {
	onRestartSidecar?: () => Promise<void>;
	onRunSop?: (slug: string) => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const [tab, setTab] = useState<PluginTab>("skills");
	const [search, setSearch] = useState("");

	return (
		<div className="flex h-full flex-col">
			{/* Window drag strip */}
			<div
				data-tauri-drag-region
				className={cn(
					"h-11 shrink-0 transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			/>

			<div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
				<PageHeader title={t("plugins.title")} />

				<div className="mb-4 flex items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<ThumbTab
							active={tab === "skills"}
							label={t("plugins.tabs.skills")}
							bgDefault="/ui/nav/skills.png"
							bgActive="/ui/nav/skills-active.png"
							onClick={() => setTab("skills")}
						/>
						<ThumbTab
							active={tab === "extensions"}
							label={t("plugins.tabs.extensions")}
							bgDefault="/ui/nav/plugins.png"
							bgActive="/ui/nav/plugins-active.png"
							onClick={() => setTab("extensions")}
						/>
						<ThumbTab
							active={tab === "mcp"}
							label={t("plugins.tabs.mcp")}
							bgDefault="/ui/nav/mcp.png"
							bgActive="/ui/nav/mcp-active.png"
							onClick={() => setTab("mcp")}
						/>
						<ThumbTab
							active={tab === "sops"}
							label={t("plugins.tabs.sops")}
							onClick={() => setTab("sops")}
						/>
					</div>
					{tab !== "mcp" && (
						<div className="flex h-8 w-64 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5">
							<UiImg src="/ui/action/search.png" size={14} />
							<input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder={t("common.search")}
								className="w-full bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none"
							/>
						</div>
					)}
				</div>

				{tab === "skills" && <SkillsTab search={search} />}
				{tab === "extensions" && <ExtensionsTab search={search} onRestartSidecar={onRestartSidecar} />}
				{tab === "mcp" && (
					<EmptyState
						icon={<Server className="h-10 w-10" />}
						title={t("plugins.mcp.comingSoon")}
						description={t("plugins.mcp.comingSoonHint")}
					/>
				)}
				{tab === "sops" && <SopsTab search={search} onRunSop={onRunSop} />}
			</div>
		</div>
	);
}
