import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	CheckCircle2,
	XCircle,
	ChevronDown,
	Loader2,
	Play,
	RotateCcw,
	Square,
	CircleDashed,
	AlertTriangle,
	Bot,
} from "lucide-react";
import {
	codegenAbort,
	codegenResume,
	codegenStart,
	codegenStatus,
	subscribeEvents,
	type CodegenState,
	type CodegenStageRecord,
} from "@/lib/transport";
import { EmptyState, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * 代码生成面板(RightDock「代码生成」tab)。
 *
 * 展示 codegen-sma 流水线的实时状态:6 阶段时间线(门禁结果/尝试次数/证据),
 * 支持从面板直接启动 / 恢复 / 中止。进度通过 CODEGEN_STATE 事件驱动刷新,
 * 阶段确认点(需求/设计)仍走 ExtensionUIDialog 弹窗。
 */

type StageStatus = "pending" | "current" | "passed" | "failed";

function stageDisplayName(t: ReturnType<typeof useTranslation>["t"], id: string): string {
	return t(`codegen.stages.${id}`, { defaultValue: id });
}

function lastRecordForStage(state: CodegenState, stageId: string): CodegenStageRecord | undefined {
	for (let i = state.records.length - 1; i >= 0; i--) {
		if (state.records[i]!.stage === stageId) return state.records[i];
	}
	return undefined;
}

function classifyStage(state: CodegenState, index: number, running: boolean): StageStatus {
	const stageId = state.stageOrder[index] ?? `stage_${index}`;
	const record = lastRecordForStage(state, stageId);
	if (record?.status === "passed") return "passed";
	if (index === state.stageIndex && !state.finishedAt) return "current";
	if (record) return "failed";
	return "pending";
}

function StageIcon({ status, running }: { status: StageStatus; running: boolean }) {
	switch (status) {
		case "passed":
			return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
		case "current":
			return running ? (
				<Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
			) : (
				<CircleDashed className="h-4 w-4 shrink-0 text-accent" />
			);
		case "failed":
			return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
		default:
			return <CircleDashed className="h-4 w-4 shrink-0 text-muted/50" />;
	}
}

function RecordRow({ record }: { record: CodegenStageRecord }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const failed = record.status !== "passed";
	const detail = [record.summary, record.evidence].filter(Boolean).join("\n\n");
	const hasDetail = Boolean(detail || record.changedFiles?.length);
	return (
		<div className="ml-6">
			<button
				type="button"
				disabled={!hasDetail}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition-colors",
					hasDetail ? "cursor-pointer hover:bg-surface-2" : "cursor-default",
				)}
			>
				{hasDetail && <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted transition-transform", !open && "-rotate-90")} />}
				<span className={cn("truncate", failed ? "text-danger/90" : "text-muted")}>
					{t(`codegen.recordStatus.${record.status}`)} · #{record.attempt}
				</span>
			</button>
			{open && hasDetail && (
				<div className="mt-0.5 space-y-1 rounded border border-border bg-bg px-2 py-1.5 text-[11px] leading-relaxed">
					{record.summary && <p className="whitespace-pre-wrap text-fg/90">{record.summary}</p>}
					{record.evidence && <p className="whitespace-pre-wrap text-danger/90">{record.evidence}</p>}
					{record.changedFiles && record.changedFiles.length > 0 && (
						<p className="font-mono text-muted">{record.changedFiles.join("\n")}</p>
					)}
				</div>
			)}
		</div>
	);
}

export default function CodegenPanel({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [state, setState] = useState<CodegenState | null>(null);
	const [running, setRunning] = useState(false);
	const [loading, setLoading] = useState(true);
	const [goal, setGoal] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const cwd = workspace ?? "";

	const refresh = useCallback(async () => {
		try {
			setError("");
			const result = await codegenStatus();
			setState(result.state);
			setRunning(result.running);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		setLoading(true);
		setState(null);
		setGoal("");
		void refresh();
	}, [cwd, refresh]);

	// CODEGEN_STATE 事件驱动实时刷新(带 _cwd 过滤,多窗口互不干扰)。
	useEffect(() => {
		if (!cwd) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		void subscribeEvents((event) => {
			if (event.type !== "CODEGEN_STATE") return;
			const eventCwd = (event as { _cwd?: unknown })._cwd;
			if (typeof eventCwd === "string" && cwd && norm(eventCwd) !== norm(cwd)) return;
			const next = (event as { state?: CodegenState }).state;
			if (next) setState(next);
			setRunning(true);
		}).then((fn) => {
			if (cancelled) {
				try { fn(); } catch { /* registry gone */ }
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			try { unlisten?.(); } catch { /* registry gone */ }
		};
	}, [cwd]);

	const handleStart = useCallback(async () => {
		const trimmed = goal.trim();
		if (!trimmed) return;
		setBusy(true);
		try {
			const result = await codegenStart(trimmed);
			setState(result.state);
			setRunning(result.running);
			setGoal("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [goal]);

	const handleResume = useCallback(async () => {
		setBusy(true);
		try {
			const result = await codegenResume();
			setState(result.state);
			setRunning(result.running);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const handleAbort = useCallback(async () => {
		setBusy(true);
		try {
			const result = await codegenAbort();
			setState(result.state);
			setRunning(result.running);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const outcomeLabel = useMemo(() => {
		if (!state?.outcome) return null;
		return t(`codegen.outcome.${state.outcome}`);
	}, [state?.outcome, t]);

	const canResume = state && !running && state.outcome !== "completed";

	if (loading) {
		return <div className="flex h-full items-center justify-center"><Spinner /></div>;
	}

	return (
		<div className="flex h-full flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{error && (
					<p className="mb-2 rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">{error}</p>
				)}

				{!state ? (
					<div className="space-y-3">
						<EmptyState
							icon={<Bot className="h-8 w-8" />}
							title={t("codegen.emptyTitle")}
							description={t("codegen.emptyDescription")}
						/>
						<textarea
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder={t("codegen.goalPlaceholder")}
							rows={4}
							className="w-full resize-none rounded-md border border-border bg-bg px-2.5 py-2 text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
						<button
							type="button"
							disabled={busy || !goal.trim()}
							onClick={() => void handleStart()}
							className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
							{t("codegen.start")}
						</button>
					</div>
				) : (
					<div className="space-y-3">
						{/* 目标 + 运行状态 */}
						<div className="rounded-md border border-border bg-bg px-2.5 py-2">
							<div className="flex items-center gap-1.5 text-[11px] text-muted">
								{running ? (
									<Loader2 className="h-3 w-3 animate-spin text-accent" />
								) : (
									<AlertTriangle className={cn("h-3 w-3", state.outcome === "completed" ? "text-success" : "text-muted")} />
								)}
								<span>
									{running
										? t("codegen.running")
										: outcomeLabel ?? t("codegen.idle")}
								</span>
								<span className="ml-auto font-mono text-[10px]">
									{state.records.length} {t("codegen.records")}
								</span>
							</div>
							<p className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg" title={state.goal}>
								{state.goal}
							</p>
						</div>

						{/* 阶段时间线 */}
						<div className="space-y-1">
							{state.stageOrder.map((stageId, index) => {
								const status = classifyStage(state, index, running);
								const record = lastRecordForStage(state, stageId);
								return (
									<div key={stageId}>
										<div className="flex items-center gap-1.5 rounded px-1 py-0.5">
											<StageIcon status={status} running={running} />
											<span
												className={cn(
													"text-xs",
													status === "current" ? "font-medium text-accent"
														: status === "passed" ? "text-fg"
															: status === "failed" ? "text-fg/80"
																: "text-muted",
												)}
											>
												{stageDisplayName(t, stageId)}
											</span>
											{status === "current" && (
												<span className="ml-auto text-[10px] text-muted">
													#{state.attempt}
												</span>
											)}
										</div>
										{record && <RecordRow record={record} />}
									</div>
								);
							})}
						</div>

						{/* 操作:恢复 / 中止 / 新任务 */}
						<div className="flex gap-2 border-t border-border pt-2">
							{running ? (
								<button
									type="button"
									disabled={busy}
									onClick={() => void handleAbort()}
									className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
								>
									<Square className="h-3.5 w-3.5" />
									{t("codegen.abort")}
								</button>
							) : (
								<>
									{canResume && (
										<button
											type="button"
											disabled={busy}
											onClick={() => void handleResume()}
											className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
										>
											<RotateCcw className="h-3.5 w-3.5" />
											{t("codegen.resume")}
										</button>
									)}
									<button
										type="button"
										disabled={busy}
										onClick={() => setState(null)}
										className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
									>
										<Play className="h-3.5 w-3.5" />
										{t("codegen.newTask")}
									</button>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
