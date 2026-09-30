import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BookDown,
	BellOff,
	Lightbulb,
	Play,
	Send,
	ShieldAlert,
	Sparkles,
	SquareStack,
	X,
} from "lucide-react";
import { subscribeEvents } from "@/lib/transport";
import {
	applySuggestion,
	dismissSuggestion,
	draftKnowledge,
	listAssistantState,
	muteAssistant,
	saveKnowledge,
	subscribeAssistantChanges,
} from "@/lib/assistant";
import type { RpcAssistantSuggestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

/**
 * 主动式交互助手（proactive-assistant 内置扩展的 GUI 面）。
 *
 * 右下角浮动小助手：后台分析当前对话，阻塞时给脱困建议、做得好时提示
 * 沉淀知识。角标被动呈现（呼吸动画提示新建议），点开才展开面板；
 * 建议可一键执行（steer/继续/压缩），知识沉淀走草稿→编辑→落盘的
 * 显式流程。挂载在 App 根（与 ExtensionUIDialog 平级），全页面可见。
 */

/** 建议卡片的图标与主色。 */
function suggestionVisual(kind: RpcAssistantSuggestion["kind"], severity: RpcAssistantSuggestion["severity"]) {
	if (kind === "knowledge_offer") {
		return { icon: Lightbulb, text: "text-amber-400", ring: "border-amber-500/40", glow: "bg-amber-500/10" };
	}
	if (kind === "context_hint") {
		return { icon: SquareStack, text: "text-violet-400", ring: "border-violet-500/40", glow: "bg-violet-500/10" };
	}
	if (severity === "warning") {
		return { icon: ShieldAlert, text: "text-danger", ring: "border-danger/40", glow: "bg-danger/10" };
	}
	return { icon: Sparkles, text: "text-accent", ring: "border-accent/40", glow: "bg-accent/10" };
}

/** 动作按钮的视觉映射（label 走 i18n）。 */
function actionVisual(kind: string) {
	switch (kind) {
		case "compact":
			return { icon: SquareStack, tone: "accent" as const };
		case "steer":
			return { icon: Send, tone: "accent" as const };
		case "continue":
			return { icon: Play, tone: "accent" as const };
		case "save_knowledge":
			return { icon: BookDown, tone: "success" as const };
		default:
			return { icon: X, tone: "neutral" as const };
	}
}

export function ProactiveAssistantWidget({ workspace, sidecarReady }: { workspace: string | null; sidecarReady: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [suggestions, setSuggestions] = useState<RpcAssistantSuggestion[]>([]);
	const [mutedUntil, setMutedUntil] = useState(0);
	const [extensionLoaded, setExtensionLoaded] = useState(true);
	const [userTurns, setUserTurns] = useState(0);
	const [pulse, setPulse] = useState(false);
	/** 知识沉淀编辑弹窗（null = 关闭）。 */
	const [knowledge, setKnowledge] = useState<{ suggestionId: string; title: string; content: string; tags: string[] } | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const knownIdsRef = useRef<Set<string>>(new Set());

	const refresh = useCallback(async () => {
		const state = await listAssistantState();
		setSuggestions(state.suggestions);
		setMutedUntil(state.mutedUntil);
		setExtensionLoaded(state.extensionLoaded);
		setUserTurns(state.userTurns);
		// 新建议出现时角标呼吸几秒；首次加载不算「新」。
		const nextIds = new Set(state.suggestions.map((s) => s.id));
		const isNew = [...nextIds].some((id) => !knownIdsRef.current.has(id));
		if (knownIdsRef.current.size > 0 && isNew) {
			setPulse(true);
			setTimeout(() => setPulse(false), 6000);
		}
		knownIdsRef.current = nextIds;
	}, []);

	// 初始拉取 + 工作区切换重拉 + 事件驱动刷新（扩展广播 proactive_assistant_changed）。
	useEffect(() => {
		if (!sidecarReady) return;
		void refresh();
	}, [sidecarReady, workspace, refresh]);

	useEffect(() => {
		if (!sidecarReady) return;
		return subscribeAssistantChanges(() => {
			void refresh();
		});
	}, [sidecarReady, refresh]);

	// 一轮对话结束后兜底刷新（事件广播丢失时的安全网）。
	useEffect(() => {
		if (!sidecarReady) return;
		let unlisten: (() => void) | undefined;
		void subscribeEvents((event) => {
			if ((event as { type?: string }).type === "AGENT_TURN_COMPLETED") {
				// 稍等片刻让扩展的 agent_end 处理与广播先落地。
				setTimeout(() => void refresh(), 500);
			}
		}).then((fn) => {
			unlisten = fn;
		});
		return () => unlisten?.();
	}, [sidecarReady, refresh]);

	if (!sidecarReady) return null;
	// 常驻模式：角标始终可见。有建议时高亮 + 数字；无建议时低对比静默态，
	// 点开可随时查看空态、会话轮数与扩展加载状态。

	const muted = mutedUntil > Date.now();
	const hasSuggestions = suggestions.length > 0;

	/** 执行建议动作：save_knowledge 走草稿流程，其余直接 apply。 */
	const handleAction = async (suggestion: RpcAssistantSuggestion, actionKind: string) => {
		if (actionKind === "dismiss") {
			await dismissSuggestion(suggestion.id);
			await refresh();
			return;
		}
		if (actionKind === "save_knowledge") {
			setSavedPath(null);
			setError(null);
			const draft = await draftKnowledge(suggestion.id);
			if (!draft) {
				setError(t("assistant.errors.draftFailed"));
				return;
			}
			setKnowledge({
				suggestionId: suggestion.id,
				title: draft.title,
				content: draft.content,
				tags: draft.tags,
			});
			return;
		}
		await applySuggestion(suggestion.id);
		await refresh();
	};

	const handleSaveKnowledge = async () => {
		if (!knowledge) return;
		setSaving(true);
		setError(null);
		try {
			const result = await saveKnowledge({
				title: knowledge.title,
				content: knowledge.content,
				tags: knowledge.tags,
			});
			if (!result) {
				setError(t("assistant.errors.saveFailed"));
				return;
			}
			await dismissSuggestion(knowledge.suggestionId);
			setSavedPath(result.path);
			await refresh();
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			{/* 浮动角标：常驻显示 */}
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title={t("assistant.badgeTitle")}
				className={cn(
					"fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full",
					"border shadow-lg transition-colors",
					muted
						? "border-border bg-surface-2 text-muted"
						: hasSuggestions
							? "border-accent/50 bg-surface text-accent hover:bg-accent/10"
							: "border-border bg-surface text-muted/80 hover:border-accent/40 hover:text-accent",
				)}
			>
				{muted ? <BellOff className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
				{hasSuggestions && (
					<span
						className={cn(
							"absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1",
							"text-[10px] font-bold text-bg",
							muted ? "bg-muted" : "bg-accent",
						)}
					>
						{suggestions.length}
					</span>
				)}
				{pulse && !muted && hasSuggestions && (
					<span className="absolute inset-0 -z-10 animate-ping rounded-full bg-accent/30" />
				)}
			</button>

			{/* 建议面板 */}
			{open && (
				<div
					className={cn(
						"fixed bottom-20 right-6 z-40 flex max-h-[60vh] w-[380px] flex-col overflow-hidden",
						"rounded-lg border border-border bg-surface shadow-2xl",
					)}
				>
					<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
						<div className="flex items-center gap-2">
							<Sparkles className="h-4 w-4 text-accent" />
							<span className="text-sm font-medium text-fg">{t("assistant.panelTitle")}</span>
							{suggestions.length > 0 && (
								<span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
									{suggestions.length}
								</span>
							)}
						</div>
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={t("common.close")}
						>
							<X className="h-4 w-4" />
						</button>
					</div>

					<div className="flex-1 space-y-2 overflow-y-auto p-3">
						{suggestions.length === 0 && (
							<div className="px-2 py-6 text-center">
								{!extensionLoaded ? (
									<p className="text-xs leading-relaxed text-warning">{t("assistant.extensionNotLoaded")}</p>
								) : (
									<>
										<p className="text-xs text-muted">{t("assistant.empty")}</p>
										<p className="mt-1 text-[11px] text-muted/70">{t("assistant.sessionTurns", { turns: userTurns })}</p>
									</>
								)}
							</div>
						)}
						{suggestions.map((s) => {
							const visual = suggestionVisual(s.kind, s.severity);
							return (
								<div key={s.id} className={cn("rounded-md border p-3", visual.ring, visual.glow)}>
									<div className="flex items-start gap-2">
										<visual.icon className={cn("mt-0.5 h-4 w-4 shrink-0", visual.text)} />
										<div className="min-w-0 flex-1">
											<p className="text-sm font-medium text-fg">{s.title}</p>
											<p className="mt-1 text-xs leading-relaxed text-muted">{s.body}</p>
											<div className="mt-2.5 flex flex-wrap gap-1.5">
												{s.actions.map((action) => {
													const av = actionVisual(action.kind);
													return (
														<Button
															key={action.kind}
															size="sm"
															variant="soft"
															tone={av.tone}
															iconLeft={<av.icon className="h-3.5 w-3.5" />}
															onClick={() => void handleAction(s, action.kind)}
														>
															{t(`assistant.actions.${action.kind}`)}
														</Button>
													);
												})}
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>

					<div className="flex items-center justify-between border-t border-border px-4 py-2">
						<span className="text-[11px] text-muted">
							{muted
								? t("assistant.mutedUntil", { time: new Date(mutedUntil).toLocaleTimeString() })
								: t("assistant.footerHint")}
						</span>
						<Button
							size="sm"
							variant="ghost"
							tone="neutral"
							iconLeft={<BellOff className="h-3.5 w-3.5" />}
							onClick={async () => {
								await muteAssistant(muted ? 0 : 60);
								await refresh();
							}}
						>
							{muted ? t("assistant.unmute") : t("assistant.muteHour")}
						</Button>
					</div>
				</div>
			)}

			{/* 知识沉淀编辑弹窗 */}
			{knowledge && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
					<div className="flex max-h-[80vh] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
						<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
							<div className="flex items-center gap-2">
								<BookDown className="h-4 w-4 text-success" />
								<span className="text-sm font-medium text-fg">{t("assistant.knowledge.title")}</span>
							</div>
							<button
								type="button"
								onClick={() => setKnowledge(null)}
								className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
								title={t("common.close")}
							>
								<X className="h-4 w-4" />
							</button>
						</div>

						{savedPath ? (
							<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
								<BookDown className="h-8 w-8 text-success" />
								<p className="text-sm text-fg">{t("assistant.knowledge.saved")}</p>
								<p className="break-all rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted">
									{savedPath}
								</p>
								<p className="text-xs text-muted">{t("assistant.knowledge.nextSession")}</p>
								<Button variant="soft" tone="success" size="sm" onClick={() => setKnowledge(null)}>
									{t("common.ok")}
								</Button>
							</div>
						) : (
							<div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
								<label className="flex flex-col gap-1">
									<span className="text-xs text-muted">{t("assistant.knowledge.titleLabel")}</span>
									<input
										value={knowledge.title}
										onChange={(e) => setKnowledge({ ...knowledge, title: e.target.value })}
										className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent/60"
									/>
								</label>
								<label className="flex flex-1 flex-col gap-1">
									<span className="text-xs text-muted">{t("assistant.knowledge.contentLabel")}</span>
									<textarea
										value={knowledge.content}
										onChange={(e) => setKnowledge({ ...knowledge, content: e.target.value })}
										rows={12}
										className="flex-1 resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs leading-relaxed text-fg outline-none focus:border-accent/60"
									/>
								</label>
								<div className="flex items-center gap-2 text-[11px] text-muted">
									<span>{t("assistant.knowledge.tagsLabel")}</span>
									{knowledge.tags.map((tag) => (
										<span key={tag} className="rounded bg-surface-2 px-1.5 py-0.5">{tag}</span>
									))}
								</div>
								{error && <p className="text-xs text-danger">{error}</p>}
								<div className="flex justify-end gap-2 border-t border-border pt-3">
									<Button variant="ghost" tone="neutral" size="sm" onClick={() => setKnowledge(null)}>
										{t("common.cancel")}
									</Button>
									<Button
										variant="solid"
										tone="success"
										size="sm"
										loading={saving}
										disabled={!knowledge.title.trim() || !knowledge.content.trim()}
										onClick={() => void handleSaveKnowledge()}
									>
										{t("assistant.knowledge.save")}
									</Button>
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}
