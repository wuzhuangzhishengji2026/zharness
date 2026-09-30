/**
 * /replay — conversation replay view, ported from dsh-replay2 ReplayView.jsx.
 *
 * Three synchronized zones driven by one flat playback cursor over the
 * timeline (real execution order):
 *   top   : business stage strip (phases + cumulative real durations + 总耗时)
 *   left  : the ACTIVE run's steps only (click to expand 输入/调用/输出 or jump)
 *   right : the ACTIVE run's artifacts (≤3) and its metrics (≤4)
 *
 * Pure display: the summary JSON fetched via JSON-RPC is the only source —
 * nothing re-executes, nothing is written.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
	buildModel,
	durationOf,
	formatDuration,
	holdDurationOf,
	isFailedResult,
	isFinished,
	jumpTargetForPhase,
	normalizeSummary,
	phaseDurationsRevealed,
	phaseStates,
	progressOf,
	resolveActiveRun,
	runAt,
	runStartGlobal,
	totalDurationOf,
	visibleRunArtifacts,
	visibleRunMetrics,
	visibleRunSteps,
} from "./replay/engine";
import type {
	Artifact,
	Metric,
	NormalizedSummary,
	PlaybackModel,
	Step,
	StepState,
} from "./replay/engine";
import { downloadFile, fetchDir, fetchFile, fetchSummary } from "./replay/api";
import type { ReplayDirEntry, ReplayDirListing, ReplayFileContent } from "./replay/api";
import { t } from "./replay/i18n";
import "./replay/replay.css";

const MARK = { done: "✓", failed: "✕", running: "●", pending: "○" } as const;

const TYPE_ICON: Record<string, string> = {
	document: "📄",
	code: "💻",
	diff: "🔀",
	report: "📊",
	log: "📋",
	image: "🖼️",
	other: "📎",
};

function typeIcon(type: string): string {
	return TYPE_ICON[type] ?? "📎";
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

function joinRel(base: string, name: string): string {
	return (base.endsWith("/") ? base : `${base}/`) + name;
}

/** prefers-reduced-motion (instant-ish replay when the user asks). */
function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined" || window.matchMedia === undefined) return;
		const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(mq.matches);
		update();
		mq.addEventListener?.("change", update);
		return () => mq.removeEventListener?.("change", update);
	}, []);
	return reduced;
}

/** Render a list under a labeled heading (inputs / calls / outputs). */
function ChipList({ label, items, className }: { label: string; items: string[]; className?: string }) {
	if (items.length === 0) return null;
	return (
		<div className={className !== undefined ? className : "rp2-io"}>
			<span className="rp2-io-label">{label}</span>
			{items.map((x, i) => (
				<span key={i} className="rp2-io-chip">
					{x}
				</span>
			))}
		</div>
	);
}

/* ============================================================ artifact modal */
function ArtifactModal({
	sessionId,
	artifact,
	onClose,
}: {
	sessionId: string;
	artifact: Artifact;
	onClose: () => void;
}) {
	const [rel, setRel] = useState<string>(() => artifact.path);
	const [kind, setKind] = useState<"dir" | "file" | "nofile">(() =>
		artifact.path.endsWith("/") ? "dir" : artifact.path === "" ? "nofile" : "file",
	);
	const [listing, setListing] = useState<ReplayDirListing | null>(null);
	const [file, setFile] = useState<ReplayFileContent | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [nav, setNav] = useState<string[]>([]);
	const urlsRef = useRef<string[]>([]);

	useEffect(() => {
		const urls = urlsRef.current;
		return () => {
			for (const u of urls) URL.revokeObjectURL(u);
			urls.length = 0;
		};
	}, []);

	useEffect(() => {
		if (kind === "nofile") return;
		let cancelled = false;
		setBusy(true);
		setError(null);
		if (kind === "dir") {
			fetchDir(sessionId, rel)
				.then((value) => {
					if (!cancelled) {
						setListing(value);
						setBusy(false);
					}
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setError(String(err instanceof Error ? err.message : err));
						setBusy(false);
					}
				});
		} else {
			fetchFile(sessionId, rel)
				.then((value) => {
					if (!cancelled) {
						setFile(value);
						setBusy(false);
					}
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setError(String(err instanceof Error ? err.message : err));
						setBusy(false);
					}
				});
		}
		return () => {
			cancelled = true;
		};
	}, [sessionId, kind, rel]);

	useEffect(() => {
		if (file?.blobUrl !== undefined && !urlsRef.current.includes(file.blobUrl)) {
			urlsRef.current.push(file.blobUrl);
		}
	}, [file?.blobUrl]);

	const openDir = (entry: ReplayDirEntry) => {
		const next = joinRel(rel, entry.name);
		setNav((n) => [...n, rel]);
		if (entry.dir) {
			setKind("dir");
			setListing(null);
		} else {
			setKind("file");
			setFile(null);
		}
		setRel(next);
	};

	const goBack = () => {
		const parent = nav[nav.length - 1];
		if (parent === undefined) {
			if (artifact.path.endsWith("/")) {
				setKind("dir");
				setRel(artifact.path);
				setListing(null);
			} else if (artifact.path !== "") {
				setKind("file");
				setRel(artifact.path);
				setFile(null);
			} else {
				setKind("nofile");
			}
			setNav([]);
			return;
		}
		setNav((n) => n.slice(0, -1));
		setKind("dir");
		setRel(parent);
		setListing(null);
	};

	const openInTab = () => {
		if (file === null) return;
		let url = file.blobUrl;
		if (url === undefined && file.text !== undefined) {
			url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
			urlsRef.current.push(url);
		}
		if (url !== undefined) window.open(url, "_blank", "noopener,noreferrer");
	};

	const onDownload = () => {
		void downloadFile(sessionId, rel).catch((err: unknown) => {
			setError(String(err instanceof Error ? err.message : err));
		});
	};

	const renderBody = () => {
		if (kind === "nofile") return <div className="rp2-modal-empty">{t("artifact.noFile")}</div>;
		if (busy)
			return (
				<div className="rp2-loading" style={{ padding: 24 }}>
					{t("view.loading")}
				</div>
			);
		if (error !== null)
			return (
				<div className="rp2-error-state" style={{ padding: 24 }}>
					{error}
				</div>
			);
		if (kind === "dir") {
			if (listing === null) return null;
			const entries = listing.entries;
			if (entries.length === 0) return <div className="rp2-dir-empty">{t("artifact.dir")}（空）</div>;
			return (
				<div className="rp2-dir-list">
					{entries.map((e) => (
						<button key={e.name} type="button" className="rp2-dir-row" onClick={() => openDir(e)}>
							<span style={{ flex: "none" }}>{e.dir ? "📁" : typeIcon("other")}</span>
							<span className="rp2-dir-name">{e.dir ? `${e.name}/` : e.name}</span>
							<span className="rp2-dir-size">
								{e.dir ? t("artifact.dir") : e.size > 0 ? `${Math.max(1, Math.round(e.size / 1024))} KB` : ""}
							</span>
						</button>
					))}
				</div>
			);
		}
		if (file === null) return null;
		const { mime, text, blobUrl, name } = file;
		const isText = text !== undefined;
		if (isText) {
			const display = text.length > 1_500_000 ? `${text.slice(0, 1_500_000)}\n… [${t("artifact.big")}]` : text;
			return (
				<div>
					<div className="rp2-file-meta">
						<span>{name}</span>
						<span>{mime}</span>
					</div>
					<pre className="rp2-code">{display}</pre>
				</div>
			);
		}
		if (mime.startsWith("image/") && blobUrl !== undefined) {
			return <img className="rp2-img-preview" src={blobUrl} alt={name} />;
		}
		if (mime === "application/pdf" && blobUrl !== undefined) {
			return <iframe className="rp2-iframe-preview" title={name} src={blobUrl} />;
		}
		return <div className="rp2-modal-empty">{t("artifact.notPreviewable")}</div>;
	};

	const canOpenFile = kind === "file" && rel !== "";

	return (
		<div
			className="rp2-backdrop"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="rp2-modal" role="dialog" aria-modal="true" aria-label={artifact.name}>
				<div className="rp2-modal-head">
					{nav.length > 0 && (
						<button type="button" className="rp2-btn" onClick={goBack}>
							{t("artifact.back")}
						</button>
					)}
					<span style={{ fontSize: 15 }}>{typeIcon(artifact.type)}</span>
					<h3>{artifact.name}</h3>
					<span className="rp2-art-type">{artifact.type}</span>
					<span className="rp2-dir-size" style={{ flex: "none" }}>
						{rel}
					</span>
					<div className="rp2-modal-head-actions">
						{canOpenFile && (
							<>
								<button type="button" className="rp2-btn" onClick={openInTab}>
									{t("artifact.open")}
								</button>
								<button type="button" className="rp2-btn" onClick={onDownload}>
									{t("artifact.download")}
								</button>
							</>
						)}
						<button type="button" className="rp2-modal-close" aria-label={t("modal.close")} onClick={onClose}>
							✕
						</button>
					</div>
				</div>
				<div className="rp2-modal-body">{renderBody()}</div>
			</div>
		</div>
	);
}

/* ================================================================= stage bar */
function StageBar({
	summary,
	model,
	cursor,
	heldRunIndex,
	revealedDurations,
	onJumpPhase,
}: {
	summary: NormalizedSummary;
	model: PlaybackModel;
	cursor: number;
	heldRunIndex: number | null;
	revealedDurations: Set<string>;
	onJumpPhase: (phaseId: string) => void;
}) {
	const states = phaseStates(summary, model, cursor, heldRunIndex);
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	const finished = isFinished(model, cursor);
	const total = totalDurationOf(summary);
	const runPhaseIds = new Set(model.runs.map((r) => r.run.phaseId));
	const visible = states.filter(({ phase }) => phase.id === "" || runPhaseIds.has(phase.id));
	const connector = visible.length > 1;
	return (
		<div className="rp2-stagebar">
			<div className="rp2-stage-chips" role="tablist" aria-label={t("view.title")}>
				{visible.map(({ phase, state }, i) => {
					const mark = state === "done" ? MARK.done : state === "current" ? MARK.running : MARK.pending;
					const reveal = revealedDurations.has(phase.id);
					return (
						<Fragment key={phase.id || i}>
							{connector && i > 0 && <span className="rp2-stage-connector">──</span>}
							<button
								type="button"
								className="rp2-stage"
								data-state={state}
								role="tab"
								aria-selected={state === "current"}
								title={phase.name}
								onClick={() => onJumpPhase(phase.id)}
							>
								<span className="rp2-stage-mark">{mark}</span>
								<span className="rp2-stage-body">
									<span className="rp2-stage-name">{phase.name}</span>
									<span className="rp2-stage-duration">
										{reveal ? formatDuration(Math.max(0, phase.actualDuration)) : ""}
									</span>
								</span>
							</button>
						</Fragment>
					);
				})}
			</div>
			<div className="rp2-total">
				<span className="rp2-total-label">{t("view.totalDuration")}</span>
				<span className="rp2-total-value">{formatDuration(total)}</span>
			</div>
			{finished && active !== null && <div className="rp2-over-badge">{t("view.over")} 🎉</div>}
		</div>
	);
}

/* ================================================================== controls */
function Controls({
	playing,
	done,
	cursor,
	model,
	heldRunIndex,
	speed,
	onTogglePlay,
	onRestart,
	onPrevRun,
	onNextRun,
	onSpeed,
}: {
	playing: boolean;
	done: boolean;
	cursor: number;
	model: PlaybackModel;
	heldRunIndex: number | null;
	speed: number;
	onTogglePlay: () => void;
	onRestart: () => void;
	onPrevRun: () => void;
	onNextRun: () => void;
	onSpeed: (speed: number) => void;
}) {
	const finished = isFinished(model, cursor);
	return (
		<div className="rp2-controls">
			<button type="button" className="rp2-btn rp2-btn-primary" onClick={onTogglePlay} disabled={finished}>
				{playing && !finished ? `⏸ ${t("control.pause")}` : `▶ ${t("control.play")}`}
			</button>
			<button type="button" className="rp2-btn" onClick={onRestart} title={t("control.restart")}>
				⏮ {t("control.restart")}
			</button>
			<button type="button" className="rp2-btn" onClick={onPrevRun} disabled={finished && cursor === 0}>
				{t("control.prev")}
			</button>
			<button type="button" className="rp2-btn" onClick={onNextRun} disabled={finished}>
				{t("control.next")}
			</button>
			<div className="rp2-seg" role="group" aria-label={t("speed")}>
				{[1, 2, 4].map((s) => (
					<button
						key={s}
						type="button"
						className="rp2-seg-btn"
						data-on={speed === s ? "true" : undefined}
						onClick={() => onSpeed(s)}
					>
						{s}×
					</button>
				))}
			</div>
			<div className="rp2-status">
				<span>
					{t("status.step")}：<b>{done ? t("status.over") : progressLabel(model, cursor, heldRunIndex)}</b>
				</span>
			</div>
		</div>
	);
}

function progressLabel(model: PlaybackModel, cursor: number, heldRunIndex: number | null = null): string {
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	if (active === null) return `${cursor}/${model.total}`;
	const runNo = active.runIndex + 1;
	if (heldRunIndex !== null || cursor >= active.end) {
		return `${t("view.currentRun")} ${runNo}/${model.totalRuns} · ${active.stepCount}/${active.stepCount}`;
	}
	const step = model.steps[cursor];
	const local = cursor - active.start + 1;
	const name = step === undefined ? "" : step.step.name;
	return `${t("view.currentRun")} ${runNo}/${model.totalRuns} · ${local}/${active.stepCount}${name.length > 0 ? ` · ${name}` : ""}`;
}

/* ================================================================= step list */
function StepRow({
	step,
	state,
	number,
	expanded,
	global,
	onToggleExpand,
	onJump,
}: {
	step: Step;
	state: StepState;
	number: number;
	expanded: boolean;
	global: number;
	onToggleExpand: () => void;
	onJump: (global: number) => void;
}) {
	const failed = state === "done" && isFailedResult(step.status);
	const confirmed = state === "done" && step.status === "confirmed";
	const dataState =
		state === "running" ? "running" : state === "done" ? (failed ? "failed-done" : confirmed ? "confirmed-done" : "done") : "pending";
	const tag =
		state === "running"
			? t("step.running")
			: state === "done"
				? failed
					? t("step.failed")
					: confirmed
						? t("step.confirmed")
						: t("step.done")
				: t("step.pending");
	const mark = state === "running" ? MARK.running : state === "done" ? (failed ? MARK.failed : MARK.done) : MARK.pending;
	const chips = step.tags.length > 0 ? step.tags : [...step.inputs, ...step.calls];
	const showChips = chips.slice(0, 4);
	return (
		<div
			className="rp2-step"
			data-state={dataState}
			onClick={() => onJump(global)}
			role="button"
			tabIndex={0}
			onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onJump(global);
				}
			}}
		>
			<div className="rp2-step-row">
				<span className="rp2-step-no">{number}</span>
				<span className="rp2-step-mark">{mark}</span>
				<span className="rp2-step-name">{step.name}</span>
				<span
					className="rp2-step-tag"
					data-ok={confirmed || (state === "done" && !failed) ? "true" : undefined}
					data-fail={failed ? "true" : undefined}
				>
					{tag}
				</span>
				<button
					type="button"
					className="rp2-btn rp2-step-expand"
					title={expanded ? t("step.collapse") : t("step.expand")}
					aria-expanded={expanded}
					onClick={(e) => {
						e.stopPropagation();
						onToggleExpand();
					}}
				>
					{expanded ? "▾" : "▸"}
				</button>
			</div>
			{state === "running" && (
				<div className="rp2-runningbar">
					<i />
				</div>
			)}
			{step.description.length > 0 && <div className="rp2-step-desc">{step.description}</div>}
			{showChips.length > 0 && (
				<div className="rp2-step-chips">
					{showChips.map((c, i) => (
						<span key={i} className="rp2-chip">
							{c}
						</span>
					))}
					{chips.length > showChips.length && (
						<span className="rp2-chip rp2-chip-more">+{chips.length - showChips.length}</span>
					)}
				</div>
			)}
			{expanded && (
				<div className="rp2-step-detail">
					<ChipList label={t("step.inputs")} items={step.inputs} />
					<ChipList label={t("step.calls")} items={step.calls} />
					<ChipList label={t("step.outputs")} items={step.outputs} />
					{step.inputs.length === 0 && step.calls.length === 0 && step.outputs.length === 0 ? (
						<div className="rp2-empty-note">{t("step.noDetail")}</div>
					) : null}
				</div>
			)}
		</div>
	);
}

function StepList({
	summary,
	model,
	cursor,
	heldRunIndex,
	expanded,
	onToggleExpand,
	onJump,
}: {
	summary: NormalizedSummary;
	model: PlaybackModel;
	cursor: number;
	heldRunIndex: number | null;
	expanded: Set<string>;
	onToggleExpand: (next: Set<string>) => void;
	onJump: (global: number) => void;
}) {
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	if (active === null) return <div className="rp2-empty">{t("view.empty.timeline")}</div>;
	const rows = visibleRunSteps(summary, model, cursor, heldRunIndex);
	return (
		<div className="rp2-steps">
			{rows.map(({ step, state, global }, i) => (
				<StepRow
					key={step.id || `${active.runIndex}-${i}`}
					step={step}
					state={state}
					number={i + 1}
					global={global}
					expanded={expanded.has(`${active.runIndex}:${i}`)}
					onToggleExpand={() => {
						const next = new Set(expanded);
						const key = `${active.runIndex}:${i}`;
						if (next.has(key)) next.delete(key);
						else next.add(key);
						onToggleExpand(next);
					}}
					onJump={onJump}
				/>
			))}
		</div>
	);
}

/* ================================================================= right col */
function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (artifact: Artifact) => void }) {
	const noOpen = artifact.path === "";
	return (
		<div
			className="rp2-art"
			data-noopen={noOpen ? "true" : undefined}
			onClick={() => !noOpen && onOpen(artifact)}
			role="button"
			tabIndex={noOpen ? -1 : 0}
			onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
				if (!noOpen && (e.key === "Enter" || e.key === " ")) {
					e.preventDefault();
					onOpen(artifact);
				}
			}}
		>
			<span className="rp2-art-icon">{typeIcon(artifact.type)}</span>
			<span className="rp2-art-main">
				<span className="rp2-art-name">{artifact.name}</span>
				<span className="rp2-art-meta">
					<span className="rp2-art-type">{artifact.type}</span>
					{artifact.description.length > 0 && (
						<span className="rp2-art-desc" title={artifact.description}>
							{artifact.description}
						</span>
					)}
				</span>
			</span>
			{!noOpen && <span className="rp2-art-arrow">›</span>}
		</div>
	);
}

function MetricCard({ metric }: { metric: Metric }) {
	return (
		<div className="rp2-metric">
			<span className="rp2-metric-value">{metric.value}</span>
			<span className="rp2-metric-name">{metric.name}</span>
		</div>
	);
}

/* ================================================================ main view */

type ViewPhase = "loading" | "error" | "none" | "empty" | "ready";

const EMPTY_SUMMARY: NormalizedSummary = {
	schemaVersion: "",
	conversationId: "",
	task: { name: "", description: "", result: "", summary: "" },
	phases: [],
	timeline: [],
};

export default function ReplayView({ sessionId: sessionIdProp }: { sessionId: string | null }) {
	const sessionId = typeof sessionIdProp === "string" && sessionIdProp.length > 0 ? sessionIdProp : null;
	const reduced = usePrefersReducedMotion();

	const [phase, setPhase] = useState<ViewPhase>("loading");
	const [errorMsg, setErrorMsg] = useState("");
	const [summary, setSummary] = useState<NormalizedSummary | null>(null);

	const [cursor, setCursorState] = useState(0);
	const [holdRun, setHoldRun] = useState<number | null>(null); // run shown as complete before advancing
	const [playing, setPlaying] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);
	const [banner, setBanner] = useState<{ text: string; type: "rollback" | "reentry" } | null>(null);
	const [revealedDurations, setRevealedDurations] = useState<Set<string>>(() => new Set());
	const bannerTimer = useRef<number | undefined>(undefined);

	const endSummary = () => {
		if (bannerTimer.current !== undefined) window.clearTimeout(bannerTimer.current);
		setBanner(null);
	};

	useEffect(() => {
		if (sessionId === null) {
			setPhase("none");
			return;
		}
		let cancelled = false;
		setPhase("loading");
		fetchSummary(sessionId)
			.then((value) => {
				if (cancelled) return;
				const normalized = normalizeSummary(value);
				if (normalized === null || normalized.timeline.length === 0) {
					setPhase(value === null ? "none" : "empty");
					setSummary(null);
				} else {
					setSummary(normalized);
					setPhase("ready");
				}
				setCursorState(0);
				setHoldRun(null);
				setRevealedDurations(new Set());
				setPlaying(true);
				endSummary();
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const msg = String(err instanceof Error ? err.message : err);
				const isCorrupt = msg.includes("replay-summary.json");
				setErrorMsg(isCorrupt ? `${t("view.error.corrupt")}：${msg}` : `${t("view.error.load")}：${msg}`);
				setPhase("error");
			});
		return () => {
			cancelled = true;
			endSummary();
		};
	}, [sessionId]);

	const model = useMemo(() => buildModel(summary ?? EMPTY_SUMMARY), [summary]);

	// auto-advance steps; on a run boundary hold the completed run (so its data
	// result / final artifacts stay visible) before the next run starts.
	useEffect(() => {
		if (summary === null || !playing || cursor >= model.total) return;
		if (holdRun !== null) return; // hold timer below governs the pause
		const ref = model.steps[cursor];
		if (ref === undefined) return;
		const dur = durationOf(ref.step, speed, reduced);
		const id = window.setTimeout(() => {
			const next = cursor + 1;
			setCursorState(clamp(next, 0, model.total));
			const run = model.runs[ref.runIndex];
			if (run !== undefined && next === run.end && ref.runIndex < model.runs.length - 1) {
				// completed a run that still has successors → brief completion hold so
				// the finished round (steps all ✓, metrics revealed) stays readable
				setHoldRun(ref.runIndex);
			}
		}, dur);
		return () => window.clearTimeout(id);
	}, [summary, playing, cursor, speed, reduced, model, holdRun]);

	// completion hold: after a run's last step, pause briefly on the completed
	// run (steps all done, metrics revealed), then continue into the next run.
	useEffect(() => {
		if (summary === null || !playing || holdRun === null) return;
		const id = window.setTimeout(() => setHoldRun(null), holdDurationOf(speed, reduced));
		return () => window.clearTimeout(id);
	}, [summary, playing, holdRun, speed, reduced]);

	// auto-dismiss the transition banner shortly after it appears
	useEffect(() => {
		if (banner === null) return;
		const id = window.setTimeout(() => setBanner(null), 3800);
		return () => window.clearTimeout(id);
	}, [banner]);

	// when entering a rollback / reentry run, show a short transition banner
	const shownTransitionRef = useRef<number | null>(null); // run index whose banner is currently on screen
	useEffect(() => {
		if (summary === null || model.total === 0 || holdRun !== null) return;
		const active = runAt(model, cursor);
		if (active === null || (active.run.type !== "rollback" && active.run.type !== "reentry")) return;
		// fire only while the cursor is inside the run (its first steps) and the
		// banner has not yet been shown for this entry
		if (shownTransitionRef.current === active.runIndex) return;
		if (cursor < active.start) return;
		shownTransitionRef.current = active.runIndex;
		const message =
			active.run.transitionMessage.length > 0
				? active.run.transitionMessage
				: `${active.run.type === "rollback" ? t("run.type.rollback") : t("run.type.reentry")}：${active.run.phaseName}`;
		setBanner({ text: message, type: active.run.type });
	}, [cursor, model, summary, holdRun]);

	// latch revealed durations once a phase has finished executing
	useEffect(() => {
		if (summary === null) return;
		const flags = phaseDurationsRevealed(summary, model, cursor);
		setRevealedDurations((prev) => {
			let changed = false;
			const next = new Set(prev);
			summary.phases.forEach((phase, i) => {
				if (flags[i] && !next.has(phase.id)) {
					next.add(phase.id);
					changed = true;
				}
			});
			return changed ? next : prev;
		});
	}, [cursor, summary, model]);

	const jump = useMemo(
		() => (globalIndex: number) => {
			setCursorState(clamp(globalIndex, 0, model.total));
			setHoldRun(null);
			setPlaying(true);
		},
		[model.total],
	);

	const jumpToPhase = (phaseId: string) => {
		if (summary === null) return;
		const target = jumpTargetForPhase(summary, model, phaseId, cursor);
		if (target === null) return;
		const g = runStartGlobal(model, target.runIndex);
		jump(g === null ? model.total : g);
	};

	const goPrevRun = () => {
		const active = resolveActiveRun(model, cursor, holdRun);
		if (active === null) return;
		const prev = active.runIndex - 1;
		if (prev < 0) {
			jump(0);
			return;
		}
		const g = runStartGlobal(model, prev);
		jump(g === null ? 0 : g);
	};

	const goNextRun = () => {
		if (cursor >= model.total) return;
		const active = resolveActiveRun(model, cursor, holdRun);
		if (active === null) return;
		const next = active.runIndex + 1;
		if (next >= model.runs.length) {
			jump(model.total);
			return;
		}
		const g = runStartGlobal(model, next);
		jump(g === null ? model.total : g);
	};

	const restart = () => {
		setCursorState(0);
		setHoldRun(null);
		setRevealedDurations(new Set());
		setPlaying(true);
		setBanner(null);
		shownTransitionRef.current = null;
	};

	const artifacts = useMemo(
		() => (summary === null ? [] : visibleRunArtifacts(summary, model, cursor, holdRun)),
		[summary, model, cursor, holdRun],
	).slice(0, 3);
	const metrics = useMemo(
		() => (summary === null ? [] : visibleRunMetrics(summary, model, cursor, holdRun)),
		[summary, model, cursor, holdRun],
	).slice(0, 4);
	const done = isFinished(model, cursor);
	const progress = progressOf(model, cursor);
	const active = resolveActiveRun(model, cursor, holdRun);
	const runHasMetrics = active !== null && active.run.metrics.length > 0;

	if (sessionId === null || phase === "none") {
		return (
			<div className="rp2-root">
				<div className="rp2-empty-state">
					<div style={{ fontSize: 34 }}>🎬</div>
					<div className="rp2-empty-title">{t("view.empty.title")}</div>
					<div className="rp2-empty-hint">{t("view.empty.hint")}</div>
				</div>
			</div>
		);
	}

	if (phase === "loading") {
		return (
			<div className="rp2-root">
				<div className="rp2-loading">{t("view.loading")}</div>
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div className="rp2-root">
				<div className="rp2-empty-state">
					<div className="rp2-error-state">{errorMsg}</div>
				</div>
			</div>
		);
	}
	if (phase === "empty" || summary === null) {
		return (
			<div className="rp2-root">
				<div className="rp2-empty-state">
					<div style={{ fontSize: 34 }}>🗂️</div>
					<div className="rp2-empty-title">{t("view.empty.timeline")}</div>
					<div className="rp2-empty-hint">{t("view.empty.onlyJson")}</div>
				</div>
			</div>
		);
	}

	const task = summary.task;
	const taskOk = isFailedResult(task.result) ? false : true;
	const taskBadge =
		task.result === "completed" || task.result === "success"
			? t("task.result.completed")
			: isFailedResult(task.result)
				? t("task.result.failed")
				: task.result.length > 0
					? task.result
					: t("task.result.running");

	return (
		<div className="rp2-root">
			{task.name.length > 0 && (
				<div className="rp2-task">
					<span className="rp2-task-name" title={task.name}>
						{task.name}
					</span>
					<span className="rp2-task-badge" data-ok={taskOk ? "true" : "false"}>
						{taskBadge}
					</span>
					{task.summary.length > 0 && <span className="rp2-task-summary">{task.summary}</span>}
				</div>
			)}

			<StageBar
				summary={summary}
				model={model}
				cursor={cursor}
				heldRunIndex={holdRun}
				revealedDurations={revealedDurations}
				onJumpPhase={jumpToPhase}
			/>

			{banner !== null && (
				<div className="rp2-banner" data-type={banner.type} role="status">
					<span className="rp2-banner-icon">{banner.type === "rollback" ? "↩" : "↪"}</span>
					<span>{banner.text}</span>
					<button type="button" className="rp2-banner-close" aria-label={t("modal.close")} onClick={() => setBanner(null)}>
						✕
					</button>
				</div>
			)}

			<Controls
				playing={playing}
				done={done}
				cursor={cursor}
				model={model}
				heldRunIndex={holdRun}
				speed={speed}
				onTogglePlay={() => setPlaying((p) => !p)}
				onRestart={restart}
				onPrevRun={goPrevRun}
				onNextRun={goNextRun}
				onSpeed={setSpeed}
			/>

			<div className="rp2-main">
				<section className="rp2-col rp2-col-left">
					<div className="rp2-col-head">
						<span>▶</span>
						<span>{t("panel.steps")}</span>
						<b>{active?.run.phaseName ?? ""}</b>
						<span style={{ marginLeft: "auto", fontWeight: 400, opacity: 0.6 }}>{progress}%</span>
					</div>
					<div className="rp2-col-body">
						<StepList
							summary={summary}
							model={model}
							cursor={cursor}
							heldRunIndex={holdRun}
							expanded={expanded}
							onToggleExpand={setExpanded}
							onJump={jump}
						/>
					</div>
				</section>

				<section className="rp2-col rp2-col-right">
					<div className="rp2-stack">
						<div className="rp2-panel">
							<div className="rp2-panel-head">
								<span>📦</span>
								<span>{t("panel.artifacts")}</span>
								<span className="rp2-panel-count">{artifacts.length}/3</span>
							</div>
							<div className="rp2-panel-body">
								{artifacts.length === 0 ? (
									<div className="rp2-empty">{t("panel.artifacts.empty")}</div>
								) : (
									<div className="rp2-cards">
										{artifacts.map(({ artifact }) => (
											<ArtifactCard key={artifact.id} artifact={artifact} onOpen={setOpenArtifact} />
										))}
									</div>
								)}
							</div>
						</div>
						{runHasMetrics && (
							<div className="rp2-panel rp2-panel-metrics">
								<div className="rp2-panel-head">
									<span>▦</span>
									<span>{t("panel.metrics")}</span>
								</div>
								<div className="rp2-panel-body">
									{metrics.length === 0 ? (
										<div className="rp2-empty rp2-metrics-wait">{t("panel.metrics.wait")}</div>
									) : (
										<div className="rp2-metrics">
											{metrics.map((m, i) => (
												<MetricCard key={i} metric={m} />
											))}
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				</section>
			</div>

			{openArtifact !== null && (
				<ArtifactModal sessionId={sessionId} artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
			)}
		</div>
	);
}
