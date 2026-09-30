import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Braces,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Gauge,
	Pencil,
	RefreshCw,
	RotateCcw,
	ScrollText,
	Send,
	SquarePen,
	Trash2,
	Wrench,
	X,
} from "lucide-react";
import {
	contextApply,
	contextOverridesClear,
	contextPreview,
	contextScoreCancel,
	contextScoreStart,
	contextScoreStatus,
} from "@/lib/transport";
import type {
	RpcContextMessage,
	RpcContextPreviewData,
	RpcContextScoreStatus,
	RpcOverrideScope,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 上下文编辑器（context-editor 内置扩展的 GUI 面）。
 *
 * 发送消息前查看「真正的上下文」：
 *  - 系统提示词：下一次请求实际生效的文本（含覆盖预演）
 *  - 工具列表：当前激活的工具定义（name / description / 参数 schema）
 *  - 消息序列：事件日志投影出的上下文，按类型着色
 *  - 上下文打分：用一次 LLM 调用评估以上整体质量（只读）
 *
 * 四个面板以滑动窗口（横向轮播）切换，顶部为分段导航。
 *
 * 编辑分两个作用域，界面对每种操作都明确标注生效范围：
 *  - 仅下一次（once）：系统提示词=本轮发送（整轮，含其中的多次 LLM 调用）；
 *    消息编辑=下一次 LLM 请求。之后自动恢复。
 *  - 每次（persistent）：本会话后续每次请求，直到清除。
 *
 * 消息编辑只改「发给 LLM 的投影」，事件日志不被修改。
 */

type Tab = "messages" | "system" | "tools" | "score";

/** 单条消息的工作副本编辑（应用前的本地暂存）。 */
type WorkingEdit =
	| { action: "edit"; text: string }
	| { action: "delete" }
	| { action: "clear" };

/** 按消息类型着色（左缘 + 徽标）。 */
const KIND_STYLE: Record<string, { border: string; text: string; labelKey: string }> = {
	user: { border: "border-sky-500/70", text: "text-sky-400", labelKey: "contextEditor.kindUser" },
	assistant: { border: "border-emerald-500/70", text: "text-emerald-400", labelKey: "contextEditor.kindAssistant" },
	toolResult: { border: "border-amber-500/70", text: "text-amber-500", labelKey: "contextEditor.kindToolResult" },
	compactionSummary: { border: "border-violet-500/70", text: "text-violet-400", labelKey: "contextEditor.kindCompaction" },
	branchSummary: { border: "border-violet-500/70", text: "text-violet-300", labelKey: "contextEditor.kindBranch" },
	custom: { border: "border-slate-500/70", text: "text-slate-400", labelKey: "contextEditor.kindCustom" },
	bashExecution: { border: "border-cyan-500/70", text: "text-cyan-400", labelKey: "contextEditor.kindBash" },
};

const SCOPE_STYLE: Record<RpcOverrideScope, { text: string; bg: string }> = {
	once: { text: "text-amber-500", bg: "bg-amber-500/10 border-amber-500/40" },
	persistent: { text: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/40" },
};

function kindStyle(kind: string) {
	return KIND_STYLE[kind] ?? KIND_STYLE.custom!;
}

export function ContextEditorDialog({
	open,
	onClose,
	draft,
	isRunning,
	onApplyAndSend,
	onOverridesChange,
}: {
	open: boolean;
	onClose: () => void;
	/** Composer 当前草稿，作为「待发送消息」展示。 */
	draft: string;
	isRunning: boolean;
	/** 「应用并发送」成功后回调（由 Composer 执行发送）。 */
	onApplyAndSend: () => void;
	/** 覆盖状态变化（Composer 按钮角标用）。 */
	onOverridesChange?: (active: boolean) => void;
}) {
	const { t } = useTranslation();
	const [tab, setTab] = useState<Tab>("messages");
	const [data, setData] = useState<RpcContextPreviewData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	// 打分建议「定位到消息」时的高亮（消息面板对应条目短暂描边）。
	const [highlightEventId, setHighlightEventId] = useState<string | null>(null);
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 工作副本：系统提示词
	const [systemDraft, setSystemDraft] = useState("");
	const [systemTouched, setSystemTouched] = useState(false);
	const [systemScope, setSystemScope] = useState<RpcOverrideScope>("once");
	// 工作副本：消息编辑（eventId → 编辑）
	const [edits, setEdits] = useState<Record<string, WorkingEdit>>({});
	const [messageScope, setMessageScope] = useState<RpcOverrideScope>("once");
	const [editingId, setEditingId] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await contextPreview(draft || undefined);
			setData(result);
			setSystemDraft(result?.effectiveSystemPrompt ?? "");
			setSystemTouched(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [draft]);

	useEffect(() => {
		if (!open) return;
		setEdits({});
		setEditingId(null);
		setStatus(null);
		void load();
	}, [open, load]);

	const tabs: Array<{ key: Tab; label: string; icon: typeof ScrollText }> = [
		{ key: "messages", label: t("contextEditor.tabMessages"), icon: ScrollText },
		{ key: "system", label: t("contextEditor.tabSystem"), icon: Braces },
		{ key: "tools", label: t("contextEditor.tabTools"), icon: Wrench },
		{ key: "score", label: t("contextEditor.tabScore"), icon: Gauge },
	];
	const slideIndex = tabs.findIndex((entry) => entry.key === tab);
	const goToSlide = useCallback((index: number) => {
		const clamped = Math.max(0, Math.min(tabs.length - 1, index));
		setTab(tabs[clamped]!.key);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tabs.length]);

	// Esc 关闭；←/→ 切换滑动页（焦点在输入控件时不拦截）。
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === "TEXTAREA" || tag === "INPUT" || tag === "PRE" || target?.isContentEditable) return;
			if (e.key === "ArrowLeft") goToSlide(slideIndex - 1);
			if (e.key === "ArrowRight") goToSlide(slideIndex + 1);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose, slideIndex, goToSlide]);

	const overridesActive = useMemo(() => {
		const o = data?.overrides;
		if (!o) return false;
		return Boolean(o.systemPromptOverride) || Object.keys(o.messageEdits).length > 0;
	}, [data]);

	useEffect(() => {
		if (open) onOverridesChange?.(overridesActive);
	}, [open, overridesActive, onOverridesChange]);

	const pendingSystemApply =
		systemTouched && systemDraft !== (data?.effectiveSystemPrompt ?? "");
	const pendingMessageApply = Object.keys(edits).length > 0;
	const hasPending = pendingSystemApply || pendingMessageApply;

	const applyEdits = useCallback(async (): Promise<boolean> => {
		setError(null);
		setStatus(null);
		try {
			const input: {
				systemPrompt?: { text: string; scope: RpcOverrideScope } | null;
				messageEdits?: Array<{
					eventId: string;
					action: "edit" | "delete" | "clear";
					text?: string;
					scope: RpcOverrideScope;
				}>;
			} = {};
			if (systemTouched) {
				input.systemPrompt = { text: systemDraft, scope: systemScope };
			}
			const messageEdits = Object.entries(edits).map(([eventId, edit]) => ({
				eventId,
				action: edit.action,
				...(edit.action === "edit" ? { text: edit.text } : {}),
				scope: messageScope,
			}));
			if (messageEdits.length > 0) input.messageEdits = messageEdits;
			if (input.systemPrompt === undefined && input.messageEdits === undefined) return true;
			const snapshot = await contextApply(input);
			setStatus(t("contextEditor.applied"));
			setEdits({});
			setSystemTouched(false);
			if (snapshot) {
				const active =
					Boolean(snapshot.systemPromptOverride) || Object.keys(snapshot.messageEdits).length > 0;
				onOverridesChange?.(active);
			}
			await load();
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		}
	}, [systemDraft, systemScope, systemTouched, edits, messageScope, load, onOverridesChange, t]);

	const handleClearAll = useCallback(async () => {
		setError(null);
		try {
			const snapshot = await contextOverridesClear("all");
			setStatus(t("contextEditor.cleared"));
			setEdits({});
			setSystemTouched(false);
			onOverridesChange?.(
				Boolean(snapshot && (snapshot.systemPromptOverride || Object.keys(snapshot.messageEdits).length > 0)),
			);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [load, onOverridesChange, t]);

	const handleApplyAndSend = useCallback(async () => {
		const ok = await applyEdits();
		if (!ok) return;
		onApplyAndSend();
		onClose();
	}, [applyEdits, onApplyAndSend, onClose]);

	// 打分建议 → 跳到消息面板并滚动/高亮目标条目。
	const jumpToMessage = useCallback((eventId?: string, index?: number) => {
		setTab("messages");
		if (highlightTimer.current) clearTimeout(highlightTimer.current);
		// 等滑动过渡结束后再滚动，否则容器还在位移。
		setTimeout(() => {
			const el = eventId
				? document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`)
				: index !== undefined
					? document.querySelector(`[data-msg-index="${index}"]`)
					: null;
			el?.scrollIntoView({ behavior: "smooth", block: "center" });
		}, 340);
		if (eventId) {
			setHighlightEventId(eventId);
			highlightTimer.current = setTimeout(() => setHighlightEventId(null), 2400);
		}
	}, []);

	useEffect(() => () => {
		if (highlightTimer.current) clearTimeout(highlightTimer.current);
	}, []);

	if (!open) return null;

	const sentCount = data?.messages.filter((m) => m.sentToLlm).length ?? 0;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
				{/* 头部 */}
				<div className="flex items-center justify-between border-b border-border px-5 py-3">
					<div className="flex items-center gap-2">
						<SquarePen className="h-4 w-4 text-accent" />
						<h2 className="text-sm font-semibold text-fg">{t("contextEditor.title")}</h2>
						{data && (
							<span className="ml-2 font-mono text-[10px] text-muted">
								{t("contextEditor.stats", {
									messages: data.messages.length,
									sent: sentCount,
									tools: data.tools.length,
								})}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => void load()}
							disabled={loading}
							className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
							title={t("contextEditor.refresh")}
						>
							<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
						</button>
						<button
							type="button"
							onClick={onClose}
							className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={t("common.close")}
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</div>

				{data && !data.extensionLoaded && (
					<div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-500">
						{t("contextEditor.extensionNotLoaded")}
					</div>
				)}

				{/* 滑动窗口分段导航 */}
				<div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
					<div className="relative grid max-w-md flex-1 grid-cols-4 rounded-lg bg-surface-2 p-1">
						{/* 滑动指示器 */}
						<span
							aria-hidden
							className="absolute inset-y-1 left-0 w-1/4 rounded-md bg-surface shadow transition-transform duration-300 ease-out"
							style={{ transform: `translateX(${slideIndex * 100}%)` }}
						/>
						{tabs.map(({ key, label, icon: Icon }) => (
							<button
								key={key}
								type="button"
								onClick={() => setTab(key)}
								className={cn(
									"relative z-10 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
									tab === key ? "text-fg" : "text-muted hover:text-fg",
								)}
							>
								<Icon className="h-3.5 w-3.5 shrink-0" />
								<span className="truncate">{label}</span>
							</button>
						))}
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => goToSlide(slideIndex - 1)}
							disabled={slideIndex <= 0}
							className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30"
							title={t("contextEditor.slidePrev")}
						>
							<ChevronLeft className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={() => goToSlide(slideIndex + 1)}
							disabled={slideIndex >= tabs.length - 1}
							className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30"
							title={t("contextEditor.slideNext")}
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
				</div>

				{/* 内容：横向滑动轨道，各面板独立滚动 */}
				<div className="min-h-0 flex-1 overflow-hidden">
					{error && (
						<div className="mx-5 mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
							{error}
						</div>
					)}
					{status && !error && (
						<div className="mx-5 mt-4 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
							{status}
						</div>
					)}
					<div className="flex h-full transition-transform duration-300 ease-out" style={{ transform: `translateX(-${slideIndex * 100}%)` }}>
						{/* 消息序列 */}
						<div className="h-full w-full shrink-0 overflow-y-auto px-5 py-4">
							{!data && loading && (
								<div className="py-16 text-center text-xs text-muted">{t("contextEditor.loading")}</div>
							)}
							{data && (
								<MessagesTab
									messages={data.messages}
									edits={edits}
									editingId={editingId}
									highlightEventId={highlightEventId}
									onEditStart={(eventId) => setEditingId(eventId)}
									onEditCancel={() => setEditingId(null)}
									onEditSave={(eventId, text) => {
										setEdits((prev) => ({ ...prev, [eventId]: { action: "edit", text } }));
										setEditingId(null);
									}}
									onDeleteToggle={(message) => {
										const existing = edits[message.eventId!];
										if (existing?.action === "delete") {
											setEdits((prev) => {
												const next = { ...prev };
												delete next[message.eventId!];
												return next;
											});
										} else {
											setEdits((prev) => ({ ...prev, [message.eventId!]: { action: "delete" } }));
										}
									}}
									onRevert={(eventId) => {
										setEdits((prev) => ({ ...prev, [eventId]: { action: "clear" } }));
									}}
								/>
							)}
						</div>

						{/* 系统提示词 */}
						<div className="h-full w-full shrink-0 overflow-y-auto px-5 py-4">
							{data && (
								<SystemTab
									data={data}
									draft={systemDraft}
									touched={systemTouched}
									scope={systemScope}
									onDraftChange={(v) => {
										setSystemDraft(v);
										setSystemTouched(true);
									}}
								/>
							)}
						</div>

						{/* 工具列表 */}
						<div className="h-full w-full shrink-0 overflow-y-auto px-5 py-4">
							{data && <ToolsTab data={data} />}
						</div>

						{/* 上下文打分 */}
						<div className="h-full w-full shrink-0 overflow-y-auto px-5 py-4">
							<ScoreTab
								active={tab === "score"}
								draft={draft}
								onJumpToMessage={jumpToMessage}
							/>
						</div>
					</div>
				</div>

				{/* 底部：作用域选择 + 操作 */}
				<div className="border-t border-border px-5 py-3">
					<div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
						{(tab === "system" || tab === "messages") && (
							<div className="flex items-center gap-1.5">
								<span>{t("contextEditor.scopeLabel")}</span>
								{(["once", "persistent"] as const).map((s) => {
									const active = tab === "system" ? systemScope === s : messageScope === s;
									return (
										<button
											key={s}
											type="button"
											onClick={() => (tab === "system" ? setSystemScope(s) : setMessageScope(s))}
											className={cn(
												"rounded-full border px-2 py-0.5 transition-colors",
												active ? SCOPE_STYLE[s].bg + " " + SCOPE_STYLE[s].text : "border-border text-muted hover:text-fg",
											)}
										>
											{t(`contextEditor.scope.${s}`)}
										</button>
									);
								})}
							</div>
						)}
						{tab === "system" && <span>{t("contextEditor.scopeHintSystem." + systemScope)}</span>}
						{tab === "messages" && <span>{t("contextEditor.scopeHintMessages." + messageScope)}</span>}
						{tab === "tools" && <span>{t("contextEditor.toolsNote")}</span>}
						{tab === "score" && <span>{t("contextEditor.score.footerHint")}</span>}
					</div>
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							onClick={() => void handleClearAll()}
							disabled={!overridesActive}
							className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
							title={t("contextEditor.clearAllHint")}
						>
							<RotateCcw className="h-3.5 w-3.5" />
							{t("contextEditor.clearAll")}
						</button>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => void applyEdits()}
								disabled={!hasPending || loading}
								className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
							>
								{t("contextEditor.apply")}
							</button>
							<button
								type="button"
								onClick={() => void handleApplyAndSend()}
								disabled={!hasPending || !draft.trim() || isRunning || loading}
								title={
									!draft.trim() ? t("contextEditor.sendNeedsDraft") : t("contextEditor.applyAndSendHint")
								}
								className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
							>
								<Send className="h-3.5 w-3.5" />
								{t("contextEditor.applyAndSend")}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 系统提示词面板
// ---------------------------------------------------------------------------

function SystemTab({
	data,
	draft,
	touched,
	scope,
	onDraftChange,
}: {
	data: RpcContextPreviewData;
	draft: string;
	touched: boolean;
	scope: RpcOverrideScope;
	onDraftChange: (value: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div>
			<div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
				<span className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-400">
					{t("contextEditor.systemPrompt")}
				</span>
				{data.systemPromptOverridden && (
					<span className={cn("rounded border px-1.5 py-0.5 text-[10px]", SCOPE_STYLE[data.systemPromptOverrideScope ?? "once"].bg, SCOPE_STYLE[data.systemPromptOverrideScope ?? "once"].text)}>
						{t("contextEditor.overridden", { scope: t(`contextEditor.scope.${data.systemPromptOverrideScope ?? "once"}`) })}
					</span>
				)}
				<span className="font-mono text-[10px] text-muted">
					{draft.length.toLocaleString()} {t("contextEditor.chars")}
				</span>
			</div>
			<textarea
				className="h-[55vh] w-full resize-none rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg outline-none focus:border-accent/60"
				value={draft}
				onChange={(e) => onDraftChange(e.target.value)}
				spellCheck={false}
			/>
			{touched && (
				<p className="mt-2 text-[11px] text-amber-500">{t("contextEditor.systemDirtyNote", { scope: t(`contextEditor.scope.${scope}`) })}</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 工具列表面板
// ---------------------------------------------------------------------------

function ToolsTab({ data }: { data: RpcContextPreviewData }) {
	const { t } = useTranslation();
	const [openTool, setOpenTool] = useState<string | null>(null);
	return (
		<div className="space-y-2">
			<p className="text-[11px] text-muted">{t("contextEditor.toolsIntro")}</p>
			{data.tools.map((tool) => {
				const expanded = openTool === tool.name;
				return (
					<div key={tool.name} className="rounded-lg border border-border">
						<button
							type="button"
							onClick={() => setOpenTool(expanded ? null : tool.name)}
							className="flex w-full items-center gap-2 px-3 py-2 text-left"
						>
							<ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", expanded && "rotate-180")} />
							<span className="font-mono text-xs text-teal-400">{tool.name}</span>
							<span className="min-w-0 flex-1 truncate text-[11px] text-muted">{tool.description}</span>
						</button>
						{expanded && (
							<pre className="max-h-64 overflow-auto border-t border-border bg-surface-2 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted">
								{tool.parametersJson}
							</pre>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 消息面板
// ---------------------------------------------------------------------------

function MessagesTab({
	messages,
	edits,
	editingId,
	highlightEventId,
	onEditStart,
	onEditCancel,
	onEditSave,
	onDeleteToggle,
	onRevert,
}: {
	messages: RpcContextMessage[];
	edits: Record<string, WorkingEdit>;
	editingId: string | null;
	highlightEventId: string | null;
	onEditStart: (eventId: string) => void;
	onEditCancel: () => void;
	onEditSave: (eventId: string, text: string) => void;
	onDeleteToggle: (message: RpcContextMessage) => void;
	onRevert: (eventId: string) => void;
}) {
	const { t } = useTranslation();
	const [editDraft, setEditDraft] = useState("");

	// 编辑入口从「当前显示文本」续编辑（含本地待应用的编辑），而非投影原文。
	const handleStart = (message: RpcContextMessage, displayText: string) => {
		setEditDraft(displayText);
		onEditStart(message.eventId!);
	};

	return (
		<div className="space-y-2">
			{messages.map((message, index) => {
				const eventId = message.eventId;
				const style = kindStyle(message.kind);
				const working = eventId ? edits[eventId] : undefined;
				// 本地待应用的编辑立即反映到显示（确认编辑后即可见新文本，
				// 无需等「应用编辑」→ 服务端 → 重新拉取预览）。
				const pendingText = working?.action === "edit" ? working.text : undefined;
				const displayText = pendingText !== undefined ? pendingText : message.text;
				const displayCharCount = pendingText !== undefined ? pendingText.length : message.charCount;
				const deleted = working?.action === "delete" || message.appliedEdit?.action === "delete";
				// 待应用：本地有未应用的编辑或删除（撤销 clear 不算）。
				const pendingLocal = Boolean(working && working.action !== "clear");
				// 服务端注入的「待发送消息」是唯一没有源事件 id 的消息。
				const isPending = !eventId;
				const canAct = Boolean(message.editable || message.deletable);

				return (
					<div
						key={eventId ?? `pending-${index}`}
						data-event-id={eventId}
						data-msg-index={index}
						className={cn(
							"rounded-lg border border-border border-l-4 bg-surface-2 px-3 py-2 transition-shadow",
							deleted && "opacity-50",
							isPending ? "border-l-accent" : style.border,
							highlightEventId && eventId === highlightEventId && "ring-2 ring-accent/70",
						)}
					>
						<div className="mb-1 flex flex-wrap items-center gap-2 text-[10px]">
							<span className="font-mono text-muted">#{index}</span>
							<span className={cn("rounded border border-current/30 px-1.5 py-0.5 font-mono", style.text)}>
								{t(style.labelKey)}
							</span>
							{message.meta?.toolName && (
								<span className="font-mono text-muted">{message.meta.toolName}</span>
							)}
							{message.meta?.toolCallNames?.map((name, i) => (
								<span key={i} className="rounded bg-amber-500/10 px-1 font-mono text-amber-500/80">
									→{name}
								</span>
							))}
							{message.meta?.hasImages && <span className="text-muted">🖼</span>}
							{message.meta?.isError && <span className="text-danger">{t("contextEditor.error")}</span>}
							{!message.sentToLlm && (
								<span className="rounded border border-slate-500/40 px-1 py-0.5 text-slate-400">
									{t("contextEditor.notSent")}
								</span>
							)}
							{message.appliedEdit && (
								<span className={cn("rounded border px-1.5 py-0.5", SCOPE_STYLE[message.appliedEdit.scope].bg, SCOPE_STYLE[message.appliedEdit.scope].text)}>
									{message.appliedEdit.action === "delete"
										? t("contextEditor.markedDelete", { scope: t(`contextEditor.scope.${message.appliedEdit.scope}`) })
										: t("contextEditor.markedEdit", { scope: t(`contextEditor.scope.${message.appliedEdit.scope}`) })}
								</span>
							)}
							{pendingLocal && (
								<span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
									{t("contextEditor.pendingEdit")}
								</span>
							)}
							<span className="ml-auto font-mono text-muted">
								{displayCharCount.toLocaleString()} {t("contextEditor.chars")}
							</span>
							{canAct && eventId && (
								<span className="flex items-center gap-1">
									{message.editable && (
										<button
											type="button"
											onClick={() => (editingId === eventId ? onEditCancel() : handleStart(message, displayText))}
											className="rounded p-0.5 text-muted transition-colors hover:bg-surface hover:text-fg"
											title={t("contextEditor.edit")}
										>
											<Pencil className="h-3 w-3" />
										</button>
									)}
									{message.appliedEdit ? (
										<button
											type="button"
											onClick={() => onRevert(eventId)}
											className="rounded p-0.5 text-muted transition-colors hover:bg-surface hover:text-fg"
											title={t("contextEditor.revertEdit")}
										>
											<RotateCcw className="h-3 w-3" />
										</button>
									) : message.deletable ? (
										<button
											type="button"
											onClick={() => onDeleteToggle(message)}
											className={cn(
												"rounded p-0.5 transition-colors hover:bg-surface",
												working?.action === "delete" ? "text-danger" : "text-muted hover:text-danger",
											)}
											title={working?.action === "delete" ? t("contextEditor.undoDelete") : t("contextEditor.delete")}
										>
											<Trash2 className="h-3 w-3" />
										</button>
									) : null}
								</span>
							)}
						</div>

						{editingId === eventId ? (
							<div>
								<textarea
									className="h-40 w-full resize-none rounded border border-border bg-surface p-2 font-mono text-[11px] leading-relaxed text-fg outline-none focus:border-accent/60"
									value={editDraft}
									onChange={(e) => setEditDraft(e.target.value)}
									spellCheck={false}
								/>
								<div className="mt-1 flex justify-end gap-2">
									<button
										type="button"
										onClick={onEditCancel}
										className="rounded px-2 py-1 text-[11px] text-muted hover:bg-surface hover:text-fg"
									>
										{t("common.cancel")}
									</button>
									<button
										type="button"
										onClick={() => onEditSave(eventId, editDraft)}
										className="rounded bg-accent px-2 py-1 text-[11px] text-accent-fg hover:opacity-90"
									>
										{t("common.confirm")}
									</button>
								</div>
							</div>
						) : (
							<pre
								className={cn(
									"max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg/90",
									deleted && "line-through",
								)}
							>
								{displayText || t("contextEditor.emptyMessage")}
							</pre>
						)}

						{message.note && (
							<p className={cn("mt-1 text-[10px]", isPending ? "text-accent" : "text-muted")}>{message.note}</p>
						)}
					</div>
				);
			})}
			{messages.length === 0 && (
				<div className="py-12 text-center text-xs text-muted">{t("contextEditor.noMessages")}</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 上下文打分面板
// ---------------------------------------------------------------------------

const SCORE_GRADE_CLASSES: Record<string, { text: string; ring: string; bar: string }> = {
	excellent: { text: "text-emerald-400", ring: "stroke-emerald-400", bar: "bg-emerald-500" },
	good: { text: "text-sky-400", ring: "stroke-sky-400", bar: "bg-sky-500" },
	fair: { text: "text-amber-500", ring: "stroke-amber-500", bar: "bg-amber-500" },
	poor: { text: "text-rose-400", ring: "stroke-rose-400", bar: "bg-rose-500" },
};

function scoreGrade(score: number): keyof typeof SCORE_GRADE_CLASSES {
	if (score >= 85) return "excellent";
	if (score >= 70) return "good";
	if (score >= 50) return "fair";
	return "poor";
}

const SCORE_LABEL_CLASSES: Record<string, string> = {
	high: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
	medium: "border-amber-500/40 bg-amber-500/10 text-amber-500",
	low: "border-rose-500/40 bg-rose-500/10 text-rose-400",
};

const SCORE_SUGGESTION_CLASSES: Record<string, string> = {
	keep: "border-border text-muted",
	trim: "border-amber-500/40 text-amber-500",
	edit: "border-sky-500/40 text-sky-400",
	delete: "border-rose-500/40 text-rose-400",
};

const DIMENSION_ORDER = ["relevance", "redundancy", "coherence", "efficiency", "reliability"] as const;

function ScoreTab({
	active,
	draft,
	onJumpToMessage,
}: {
	active: boolean;
	draft: string;
	onJumpToMessage: (eventId?: string, index?: number) => void;
}) {
	const { t } = useTranslation();
	const [score, setScore] = useState<RpcContextScoreStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());

	const draftArg = draft.trim() ? draft : undefined;

	// 面板可见时拉一次状态。
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void (async () => {
			const s = await contextScoreStatus(draftArg);
			if (!cancelled) setScore(s);
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// 运行中轮询 + 计时。
	const running = score?.status === "running";
	useEffect(() => {
		if (!active || !running) return;
		const poll = setInterval(async () => {
			const s = await contextScoreStatus(draftArg);
			setScore(s);
		}, 1500);
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
		};
	}, [active, running, draftArg]);

	const handleStart = async (force: boolean) => {
		setBusy(true);
		try {
			const s = await contextScoreStart(draftArg, force);
			setScore(s);
		} finally {
			setBusy(false);
		}
	};

	const handleCancel = async () => {
		setBusy(true);
		try {
			const s = await contextScoreCancel();
			setScore(s);
		} finally {
			setBusy(false);
		}
	};

	const result = score?.status === "done" ? score.result : undefined;
	const elapsed =
		running && score?.startedAt
			? Math.max(0, Math.round((now - score.startedAt) / 1000))
			: null;

	const dimensions = useMemo(() => {
		if (!result) return [];
		const byKey = new Map(result.dimensions.map((d) => [d.key as string, d]));
		const ordered: string[] = [...DIMENSION_ORDER];
		for (const key of byKey.keys()) {
			if (!ordered.includes(key)) ordered.push(key);
		}
		return ordered.filter((key) => byKey.has(key)).map((key) => byKey.get(key)!);
	}, [result]);

	return (
		<div className="space-y-4">
			<p className="text-[11px] leading-relaxed text-muted">{t("contextEditor.score.intro")}</p>

			{/* 操作区 */}
			<div className="flex flex-wrap items-center gap-2">
				{running ? (
					<>
						<button
							type="button"
							onClick={() => void handleCancel()}
							disabled={busy}
							className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
						>
							{t("contextEditor.score.cancel")}
						</button>
						<span className="flex items-center gap-2 text-xs text-accent">
							<RefreshCw className="h-3.5 w-3.5 animate-spin" />
							{t("contextEditor.score.running")}
							{elapsed !== null && (
								<span className="font-mono text-[11px] text-muted">
									{t("contextEditor.score.elapsed", { sec: elapsed })}
								</span>
							)}
						</span>
					</>
				) : (
					<button
						type="button"
						onClick={() => void handleStart(score?.status === "done")}
						disabled={busy}
						className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<Gauge className="h-3.5 w-3.5" />
						{score?.status === "done" ? t("contextEditor.score.rerun") : t("contextEditor.score.start")}
					</button>
				)}
				{score?.model && (
					<span className="font-mono text-[10px] text-muted">
						{t("contextEditor.score.model")}: {score.model}
					</span>
				)}
			</div>

			{score?.status === "error" && score.error && (
				<div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
					{t("contextEditor.score.failed")}: {score.error}
				</div>
			)}

			{result && score?.stale && (
				<div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
					{t("contextEditor.score.staleWarning")}
				</div>
			)}

			{result && (
				<>
					{/* 总分 */}
					<div className="flex items-center gap-4 rounded-xl border border-border bg-surface-2 px-4 py-3">
						<ScoreRing value={result.overall} />
						<div className="min-w-0 flex-1">
							<div className="text-xs font-medium text-fg">
								{t("contextEditor.score.overall")}
								<span className="ml-2 font-mono text-lg">{result.overall}</span>
								<span className={cn("ml-2 text-xs", SCORE_GRADE_CLASSES[scoreGrade(result.overall)].text)}>
									{t(`contextEditor.score.grade.${scoreGrade(result.overall)}`)}
								</span>
							</div>
							{score?.finishedAt && (
								<div className="mt-1 font-mono text-[10px] text-muted">
									{t("contextEditor.score.scoredAt", {
										time: new Date(score.finishedAt).toLocaleTimeString(),
									})}
								</div>
							)}
						</div>
					</div>

					{/* 维度评分 */}
					{dimensions.length > 0 && (
						<div>
							<h3 className="mb-2 text-xs font-semibold text-fg">{t("contextEditor.score.dimensionsTitle")}</h3>
							<div className="space-y-2 rounded-xl border border-border bg-surface-2 px-4 py-3">
								{dimensions.map((d) => {
									const grade = scoreGrade(d.score);
									return (
										<div key={d.key}>
											<div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
												<span className="text-fg">
													{t(`contextEditor.score.dim.${d.key}`, { defaultValue: d.key })}
													<span className="ml-1.5 font-mono text-muted">{d.score}</span>
												</span>
												{d.comment && (
													<span className="min-w-0 flex-1 truncate text-right text-muted" title={d.comment}>
														{d.comment}
													</span>
												)}
											</div>
											<div className="h-1.5 overflow-hidden rounded-full bg-border/60">
												<div
													className={cn("h-full rounded-full transition-all duration-500", SCORE_GRADE_CLASSES[grade].bar)}
													style={{ width: `${d.score}%` }}
												/>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* 总评 */}
					{result.summary && (
						<div>
							<h3 className="mb-2 text-xs font-semibold text-fg">{t("contextEditor.score.summaryTitle")}</h3>
							<p className="whitespace-pre-wrap rounded-xl border border-border bg-surface-2 px-4 py-3 text-xs leading-relaxed text-fg/90">
								{result.summary}
							</p>
						</div>
					)}

					{/* 消息建议 */}
					<div>
						<h3 className="mb-2 text-xs font-semibold text-fg">{t("contextEditor.score.annotationsTitle")}</h3>
						{result.messageAnnotations.length === 0 ? (
							<p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-xs text-muted">
								{t("contextEditor.score.noAnnotations")}
							</p>
						) : (
							<div className="space-y-1.5">
								{result.messageAnnotations.map((a, i) => (
									<button
										key={`${a.index}-${i}`}
										type="button"
										onClick={() => onJumpToMessage(a.eventId, a.index)}
										className="flex w-full items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:border-accent/50"
										title={t("contextEditor.score.jumpToMessage")}
									>
										<span className="font-mono text-[10px] text-muted">#{a.index}</span>
										<span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]", SCORE_LABEL_CLASSES[a.label])}>
											{t(`contextEditor.score.label.${a.label}`)}
										</span>
										{a.suggestion && (
											<span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]", SCORE_SUGGESTION_CLASSES[a.suggestion])}>
												{t(`contextEditor.score.suggestion.${a.suggestion}`)}
											</span>
										)}
										{a.reason && <span className="min-w-0 flex-1 text-[11px] text-fg/90">{a.reason}</span>}
									</button>
								))}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}

/** 总分圆环（0-100）。 */
function ScoreRing({ value }: { value: number }) {
	const size = 56;
	const stroke = 5;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	const grade = scoreGrade(value);
	return (
		<div className="relative flex shrink-0 items-center justify-center">
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
				<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border, #333)" strokeWidth={stroke} />
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - value / 100)}
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
					className={cn("transition-all duration-500", SCORE_GRADE_CLASSES[grade].ring)}
				/>
			</svg>
		</div>
	);
}
