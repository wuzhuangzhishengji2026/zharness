import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, RefreshCw } from "lucide-react";
import { sendCommandAwait, subscribeEvents } from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";
import { Badge, EmptyState, StatusDot } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Format a token count compactly (e.g. 12.3k, 1.2M). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
			<span className="shrink-0 text-xs text-muted">{label}</span>
			<span className="min-w-0 truncate text-xs font-medium text-fg">{children}</span>
		</div>
	);
}

/**
 * 执行状态面板：展示当前工作区会话的实时运行状态（流式/压缩/空闲）、
 * 模型与审批策略、上下文占用与累计 token 用量。数据来自 get_state，
 * 并订阅事件流自动刷新。
 */
export default function ExecutionStatus({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [ready, setReady] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const r = await sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000);
			setState(r.data ?? null);
			setReady(true);
		} catch {
			setReady(false);
		}
	}, []);

	useEffect(() => {
		setState(null);
		void refresh();
	}, [refresh, workspace]);

	// Refresh on lifecycle events for this workspace.
	useEffect(() => {
		let cancelled = false;
		let un: (() => void) | null = null;
		(async () => {
			const unlisten = await subscribeEvents((event) => {
				const typed = event as { type: string; _cwd?: string };
				if (typed._cwd && typed._cwd !== (workspace ?? "")) return;
				if (
					typed.type === "AGENT_TURN_START" ||
					typed.type === "AGENT_TURN_COMPLETED" ||
					typed.type === "MODEL_CHANGED" ||
					typed.type === "THINKING_LEVEL_CHANGED" ||
					typed.type.startsWith("COMPACTION_")
				) {
					void refresh();
				}
			});
			if (cancelled) {
				unlisten();
				return;
			}
			un = unlisten;
		})();
		return () => {
			cancelled = true;
			un?.();
		};
	}, [refresh, workspace]);

	if (!ready || !state) {
		return (
			<div className="p-3">
				<EmptyState
					icon={<Gauge className="h-10 w-10" />}
					title={t("execution.notReady")}
				/>
			</div>
		);
	}

	const running = state.isStreaming;
	const compacting = state.isCompacting;
	const statusTone = running ? "success" : compacting ? "warning" : "neutral";
	const statusLabel = running
		? t("execution.running")
		: compacting
			? t("execution.compacting")
			: t("execution.idle");

	const ctx = state.contextUsage;
	const pct = ctx?.percent != null ? Math.min(100, Math.max(0, ctx.percent)) : null;
	const usage = state.tokenUsage;

	return (
		<div className="space-y-3 overflow-y-auto p-3">
			{/* 运行状态 */}
			<section className="rounded-xl border border-border bg-surface">
				<header className="flex items-center justify-between border-b border-border px-3.5 py-2">
					<span className="text-xs font-semibold text-fg">{t("execution.title")}</span>
					<button
						type="button"
						onClick={() => void refresh()}
						className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("execution.refresh")}
					>
						<RefreshCw className="h-3 w-3" />
					</button>
				</header>
				<div className="divide-y divide-border/60">
					<Row label={t("execution.status")}>
						<span className="inline-flex items-center gap-1.5">
							<StatusDot tone={statusTone} />
							{statusLabel}
						</span>
					</Row>
					<Row label={t("execution.model")}>
						{state.model ? (
							<span className="inline-flex items-center gap-1.5">
								{state.model.name ?? state.model.id}
								<Badge tone="accent" className="font-mono text-[10px]">
									{state.model.provider}
								</Badge>
							</span>
						) : (
							t("execution.noModel")
						)}
					</Row>
					<Row label={t("execution.thinkingLevel")}>{state.thinkingLevel}</Row>
					<Row label={t("execution.safeMode")}>
						<Badge tone={state.safeMode ? "warning" : "neutral"}>
							{state.safeMode ? t("execution.safeModeOn") : t("execution.safeModeOff")}
						</Badge>
					</Row>
					<Row label={t("execution.messages")}>{state.messageCount}</Row>
				</div>
			</section>

			{/* 上下文占用 */}
			<section className="rounded-xl border border-border bg-surface px-3.5 py-3">
				<div className="mb-2 flex items-center justify-between">
					<span className="text-xs font-semibold text-fg">{t("execution.context")}</span>
					<span className="text-[11px] text-muted">
						{pct != null && ctx
							? `${formatTokens(ctx.tokens ?? 0)} / ${formatTokens(ctx.contextWindow)} (${pct.toFixed(1)}%)`
							: "—"}
					</span>
				</div>
				<div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
					<div
						className={cn(
							"h-full rounded-full transition-[width] duration-300",
							pct == null
								? "w-0"
								: pct > 90
									? "bg-danger"
									: pct > 70
										? "bg-warning"
										: "bg-success",
						)}
						style={{ width: `${pct ?? 0}%` }}
					/>
				</div>
			</section>

			{/* Token 用量 */}
			{usage && (
				<section className="rounded-xl border border-border bg-surface">
					<header className="border-b border-border px-3.5 py-2">
						<span className="text-xs font-semibold text-fg">{t("execution.tokens")}</span>
					</header>
					<div className="divide-y divide-border/60">
						<Row label={t("execution.input")}>{formatTokens(usage.totalInput)}</Row>
						<Row label={t("execution.output")}>{formatTokens(usage.totalOutput)}</Row>
						{usage.totalCacheRead > 0 && (
							<Row label={t("composer.cacheRead")}>{formatTokens(usage.totalCacheRead)}</Row>
						)}
						{usage.totalCacheWrite > 0 && (
							<Row label={t("composer.cacheWrite")}>{formatTokens(usage.totalCacheWrite)}</Row>
						)}
						{usage.totalCost > 0 && (
							<Row label={t("execution.cost")}>${usage.totalCost.toFixed(3)}</Row>
						)}
					</div>
				</section>
			)}

			{/* 会话信息 */}
			<section className="rounded-xl border border-border bg-surface px-3.5 py-2.5">
				<span className="text-[11px] text-muted">{t("execution.session")}</span>
				<p className="mt-0.5 truncate font-mono text-[11px] text-fg" title={state.sessionId}>
					{state.sessionId}
				</p>
			</section>
		</div>
	);
}
