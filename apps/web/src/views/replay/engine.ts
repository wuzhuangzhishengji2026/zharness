/**
 * /replay — pure playback model (schema 2.0), ported from dsh-replay2 engine.js.
 *
 * The summary file is the ONLY data source. Two layers:
 *   Task
 *     ├─ Phase[]    business stages (order = business order) + cumulative real duration
 *     └─ Timeline[] real execution order (normal / rollback / reentry), each run
 *                   carries its own steps / artifacts / metrics
 *
 * Playback cursor is a flat count of completed steps over the *timeline*
 * (real execution order). Each run occupies a step range; the top stage bar
 * is derived from the phase of the run that contains the cursor. No React,
 * no DOM: unit-testable in node.
 */

/** Default per-step display duration when the summary omits `replayDuration`. */
export const DEFAULT_DURATION = 3000;

/** Minimum effective step duration (keeps rapid mode visually coherent). */
export const MIN_DURATION = 80;

/** Post-run completion hold (ms at 1×) before auto-advancing to the next run. */
export const HOLD_DURATION = 1800;

/** Accepted 'failed' spellings. */
const FAILED_RESULTS = new Set(["failed", "failure", "error", "fail"]);

export function isFailedResult(value: unknown): boolean {
	return typeof value === "string" && FAILED_RESULTS.has(value.toLowerCase());
}

/** Step final statuses understood by the UI (everything else → success). */
const KNOWN_STATUS = new Set(["success", "confirmed", "failed"]);

export interface Phase {
	id: string;
	name: string;
	actualDuration: number;
}

export type RunType = "normal" | "rollback" | "reentry";

export interface Step {
	id: string;
	name: string;
	description: string;
	tags: string[];
	inputs: string[];
	calls: string[];
	outputs: string[];
	status: string;
	artifactIds: string[];
	replayDuration: number;
}

export interface Artifact {
	id: string;
	name: string;
	type: string;
	path: string;
	description: string;
}

export interface Metric {
	name: string;
	value: string;
}

export interface TimelineRun {
	id: string;
	phaseId: string;
	phaseName: string;
	phaseIndex: number;
	type: RunType;
	fromPhaseId: string;
	transitionMessage: string;
	replayDuration: number;
	steps: Step[];
	artifacts: Artifact[];
	metrics: Metric[];
}

export interface TaskInfo {
	name: string;
	description: string;
	result: string;
	summary: string;
}

export interface NormalizedSummary {
	schemaVersion: string;
	conversationId: string;
	task: TaskInfo;
	phases: Phase[];
	timeline: TimelineRun[];
}

export interface RunSlice {
	runIndex: number;
	run: TimelineRun;
	start: number;
	end: number;
	stepCount: number;
}

export interface StepRef {
	global: number;
	runIndex: number;
	stepIndex: number;
	run: TimelineRun;
	step: Step;
}

export interface PlaybackModel {
	runs: RunSlice[];
	steps: StepRef[];
	total: number;
	totalRuns: number;
}

export type PhaseState = "done" | "current" | "pending";
export type StepState = "done" | "running" | "pending";

export interface VisibleArtifact {
	artifact: Artifact;
	producedByStep: number | null;
}

export interface JumpTarget {
	run: TimelineRun;
	runIndex: number;
	stepIndex: number;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function numFinite(value: unknown, fallback = 0): number {
	return Number.isFinite(value) ? Number(value) : fallback;
}

/**
 * Normalize a raw parsed summary JSON (schema 2.0) into the model the UI
 * consumes. Never throws; unusable input yields null (no summary). A summary
 * without a timeline still normalizes (timeline = []) so the caller can show
 * the proper empty state.
 */
export function normalizeSummary(raw: unknown): NormalizedSummary | null {
	const src = asRecord(raw);
	if (src === null) return null;

	const phases: Phase[] = [];
	const phaseById = new Map<string, Phase>();
	asArray(src.phases).forEach((rawPhase, i) => {
		const rec = asRecord(rawPhase);
		if (rec === null) return;
		const phase: Phase = {
			id: str(rec.id),
			name: str(rec.name, str(rec.id, `阶段 ${i + 1}`)) || `阶段 ${i + 1}`,
			actualDuration: Math.max(0, numFinite(rec.actualDuration, 0)),
		};
		phases.push(phase);
		if (phase.id !== "") phaseById.set(phase.id, phase);
	});

	const timeline: TimelineRun[] = [];
	asArray(src.timeline).forEach((rawRun) => {
		const rec = asRecord(rawRun);
		if (rec === null) return;
		const phase = (typeof rec.phaseId === "string" ? phaseById.get(rec.phaseId) : undefined) ?? null;
		const type: RunType = rec.type === "rollback" || rec.type === "reentry" ? rec.type : "normal";
		const steps: Step[] = [];
		const artifacts: Artifact[] = [];
		const artifactsById = new Map<string, Artifact>();

		asArray(rec.artifacts).forEach((rawArtifact, k) => {
			const arec = asRecord(rawArtifact);
			if (arec === null) return;
			const artifact: Artifact = {
				id: str(arec.id),
				name: str(arec.name, str(arec.id, `产出 ${k + 1}`)) || `产出 ${k + 1}`,
				type: typeof arec.type === "string" && arec.type.length > 0 ? arec.type : "other",
				path: str(arec.path),
				description: str(arec.description),
			};
			artifacts.push(artifact);
			if (artifact.id !== "") artifactsById.set(artifact.id, artifact);
		});

		const run: TimelineRun = {
			id: str(rec.id),
			phaseId: phase === null ? str(rec.phaseId) : phase.id,
			phaseName: phase === null ? str(rec.phaseId) || `阶段 · 第${timeline.length + 1}轮` : phase.name,
			phaseIndex: phase === null ? -1 : phases.indexOf(phase),
			type,
			fromPhaseId: str(rec.fromPhaseId),
			transitionMessage: str(rec.transitionMessage),
			replayDuration: Math.max(0, numFinite(rec.replayDuration, 0)),
			steps,
			artifacts,
			metrics: asArray(rec.metrics)
				.map((m) => asRecord(m))
				.filter((m): m is Record<string, unknown> => m !== null)
				.map((m) => ({
					name: str(m.name),
					value: m.value !== undefined && m.value !== null ? String(m.value) : "",
				})),
		};
		asArray(rec.steps).forEach((rawStep, j) => {
			const srec = asRecord(rawStep);
			if (srec === null) return;
			const status =
				typeof srec.status === "string" && KNOWN_STATUS.has(srec.status)
					? srec.status
					: typeof srec.result === "string" && KNOWN_STATUS.has(srec.result)
						? srec.result
						: "success";
			const artifactIds = asArray(srec.artifactIds).filter(
				(x): x is string => typeof x === "string" && artifactsById.has(x),
			);
			steps.push({
				id: str(srec.id),
				name: str(srec.name, `步骤 ${j + 1}`) || `步骤 ${j + 1}`,
				description: str(srec.description),
				tags: asArray(srec.tags).filter((x): x is string => typeof x === "string"),
				inputs: asArray(srec.inputs).filter((x): x is string => typeof x === "string"),
				calls: asArray(srec.calls).filter((x): x is string => typeof x === "string"),
				outputs: asArray(srec.outputs).filter((x): x is string => typeof x === "string"),
				status,
				artifactIds,
				replayDuration: Math.max(0, numFinite(srec.replayDuration, 0)),
			});
		});
		timeline.push(run);
	});

	// 旧版归档(DSH 导出,version "3.0" / 1.x)没有 timeline[],而是
	// phases[].steps + 顶层 artifacts + summary_metrics。为每个有内容的阶段
	// 合成一轮 normal run,让旧摘要也能播放。
	if (timeline.length === 0) {
		const legacyArtifacts: Artifact[] = [];
		const legacyArtifactById = new Map<string, Artifact>();
		asArray(src.artifacts).forEach((rawArtifact, k) => {
			const arec = asRecord(rawArtifact);
			if (arec === null) return;
			const artifact: Artifact = {
				id: str(arec.id),
				name: str(arec.name, str(arec.id, `产出 ${k + 1}`)) || `产出 ${k + 1}`,
				type: typeof arec.type === "string" && arec.type.length > 0 ? arec.type : "other",
				path: str(arec.path),
				description: str(arec.description),
			};
			legacyArtifacts.push(artifact);
			if (artifact.id !== "") legacyArtifactById.set(artifact.id, artifact);
		});
		const legacyMetrics: Metric[] = Object.entries(asRecord(src.summary_metrics) ?? {}).map(
			([name, value]) => ({ name, value: value !== null && value !== undefined ? String(value) : "" }),
		);

		asArray(src.phases).forEach((rawPhase) => {
			const prec = asRecord(rawPhase);
			if (prec === null) return;
			const rawSteps = asArray(prec.steps);
			if (rawSteps.length === 0) return; // 无内容阶段不放行(与 2.0 质量门一致)
			const phase = (typeof prec.id === "string" ? phaseById.get(prec.id) : undefined) ?? null;

			const steps: Step[] = [];
			const usedArtifactIds = new Set<string>();
			rawSteps.forEach((rawStep, j) => {
				const srec = asRecord(rawStep);
				if (srec === null) return;
				const status =
					typeof srec.status === "string" && KNOWN_STATUS.has(srec.status)
						? srec.status
						: typeof srec.result === "string" && KNOWN_STATUS.has(srec.result)
							? srec.result
							: "success";
				const artifactIds = asArray(srec.artifactIds).filter(
					(x): x is string => typeof x === "string" && legacyArtifactById.has(x),
				);
				for (const aid of artifactIds) usedArtifactIds.add(aid);
				steps.push({
					id: str(srec.id),
					name: str(srec.name, `步骤 ${j + 1}`) || `步骤 ${j + 1}`,
					description: str(srec.description),
					tags: asArray(srec.tags).filter((x): x is string => typeof x === "string"),
					inputs: asArray(srec.inputs).filter((x): x is string => typeof x === "string"),
					calls: asArray(srec.calls).filter((x): x is string => typeof x === "string"),
					outputs: asArray(srec.outputs).filter((x): x is string => typeof x === "string"),
					status,
					artifactIds,
					replayDuration: Math.max(0, numFinite(srec.duration, numFinite(srec.replayDuration, 0))),
				});
			});
			if (steps.length === 0) return;
			// 阶段实际耗时 = 步骤时长求和
			if (phase !== null) phase.actualDuration = steps.reduce((acc, s) => acc + s.replayDuration, 0);
			timeline.push({
				id: phase !== null ? `run-${phase.id}` : `run-${timeline.length + 1}`,
				phaseId: phase !== null ? phase.id : str(prec.id),
				phaseName: phase !== null ? phase.name : str(prec.name) || `阶段 · 第${timeline.length + 1}轮`,
				phaseIndex: phase !== null ? phases.indexOf(phase) : -1,
				type: "normal",
				fromPhaseId: "",
				transitionMessage: "",
				replayDuration: 0,
				steps,
				artifacts: legacyArtifacts.filter((a) => usedArtifactIds.has(a.id)),
				metrics: [],
			});
		});

		// 未被任何步骤引用的产物与 summary_metrics 挂到最后一轮,保证可见。
		if (timeline.length > 0) {
			const attached = new Set(timeline.flatMap((r) => r.artifacts.map((a) => a.id)));
			const last = timeline[timeline.length - 1];
			for (const a of legacyArtifacts) {
				if (!attached.has(a.id)) last.artifacts.push(a);
			}
			last.metrics.push(...legacyMetrics);
		}
	}

	const taskRec = asRecord(src.task);
	const task: TaskInfo =
		taskRec !== null
			? {
					name: str(taskRec.name),
					description: str(taskRec.description),
					result: str(taskRec.result),
					summary: str(taskRec.summary),
				}
			: { name: "", description: "", result: "", summary: "" };

	return {
		schemaVersion: str(src.schemaVersion, str(src.version, "")),
		conversationId: str(src.conversationId),
		task,
		phases,
		timeline,
	};
}

/**
 * Total real business duration across phases (used for the 总耗时 label).
 * @returns ms
 */
export function totalDurationOf(summary: NormalizedSummary): number {
	return summary.phases.reduce((acc, p) => acc + Math.max(0, p.actualDuration), 0);
}

/**
 * Format a real duration as the spec's Chinese labels: 1小时30分 / 45分钟 /
 * 9小时35分 / 3小时08分. Sub-minute values render as seconds.
 */
export function formatDuration(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	if (totalSec <= 0) return "0秒";
	if (totalSec < 60) return `${totalSec}秒`;
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	if (h > 0) return m > 0 ? `${h}小时${String(m).padStart(2, "0")}分` : `${h}小时`;
	return `${m}分钟`;
}

/** Flat playback index over timeline steps (real execution order). */
export function buildModel(summary: NormalizedSummary): PlaybackModel {
	const runs: RunSlice[] = [];
	const steps: StepRef[] = [];
	let cursor = 0;
	summary.timeline.forEach((run, runIndex) => {
		const start = cursor;
		run.steps.forEach((step, stepIndex) => {
			steps.push({ global: cursor, runIndex, stepIndex, run, step });
			cursor += 1;
		});
		runs.push({ runIndex, run, start, end: cursor, stepCount: run.steps.length });
	});
	return { runs, steps, total: cursor, totalRuns: runs.length };
}

/**
 * The run that owns the given global cursor position. When cursor sits past
 * the last step (finished), returns the final run.
 */
export function runAt(model: PlaybackModel, cursor: number): RunSlice | null {
	if (model.total === 0) return null;
	const clamped = Math.min(Math.max(0, cursor), model.total);
	for (const r of model.runs) {
		if (clamped >= r.start && clamped < r.end) return r;
	}
	return model.runs[model.runs.length - 1] ?? null;
}

/**
 * Resolve which run the UI should display. During the short post-run hold a
 * just-completed run stays on screen (all its steps done, its metrics
 * revealed) before auto-advancing into the next run, so callers pass
 * `heldRunIndex` to override the plain cursor-owning run.
 */
export function resolveActiveRun(
	model: PlaybackModel,
	cursor: number,
	heldRunIndex: number | null = null,
): RunSlice | null {
	if (heldRunIndex !== null && model.runs[heldRunIndex] !== undefined) {
		return model.runs[heldRunIndex];
	}
	return runAt(model, cursor);
}

/** True when the whole timeline finished (cursor at the very end). */
export function isFinished(model: PlaybackModel, cursor: number): boolean {
	return model.total > 0 && cursor >= model.total;
}

/**
 * Cursor boundary after which a business phase has fully executed: the end of
 * the LAST timeline run belonging to that phase. The top bar reveals the
 * phase's real duration only past this point.
 * @returns cursor value, or -1 when the phase has no run
 */
export function phaseDurationAt(model: PlaybackModel, phaseId: string): number {
	let at = -1;
	for (const r of model.runs) {
		if (r.run.phaseId === phaseId) at = Math.max(at, r.end);
	}
	return at;
}

/**
 * Per-phase reveal flags for the top stage strip: whether the real business
 * duration of each business phase should be shown at this cursor (the phase
 * has finished executing — all its runs are past). Aligned with summary.phases.
 */
export function phaseDurationsRevealed(
	summary: NormalizedSummary,
	model: PlaybackModel,
	cursor: number,
): boolean[] {
	return summary.phases.map((phase) =>
		phase.id === "" ? false : cursor >= phaseDurationAt(model, phase.id),
	);
}

/**
 * Phase chip state for the top stage bar.
 *
 * State is derived from the run that is currently displayed. During a
 * post-run hold the just-completed run stays on screen (its own phase stays
 * highlighted as 'current' until the next run begins):
 *  - the active run's phase → 'current'
 *  - business phases before the active phase → 'done'
 *  - business phases after the active phase → 'pending' (even when a later
 *    phase has been visited once — e.g. after rollback, 测试 reverts to ○)
 * When playback finished, every phase with runs is done.
 */
export function phaseStates(
	summary: NormalizedSummary,
	model: PlaybackModel,
	cursor: number,
	heldRunIndex: number | null = null,
): Array<{ phase: Phase; state: PhaseState }> {
	if (model.total === 0 || summary.phases.length === 0) {
		return summary.phases.map((phase) => ({ phase, state: "pending" as const }));
	}
	if (isFinished(model, cursor)) {
		return summary.phases.map((phase) => ({ phase, state: "done" as const }));
	}
	// post-run hold: the just-completed run's phase (and every earlier business
	// phase) reads as done — the completion beat shows ✓ + the revealed
	// duration; later phases stay pending until the next run starts.
	if (heldRunIndex !== null && model.runs[heldRunIndex] !== undefined) {
		const heldIdx = model.runs[heldRunIndex].run.phaseIndex;
		return summary.phases.map((phase, idx) => ({
			phase,
			state: (idx <= heldIdx ? "done" : "pending") as PhaseState,
		}));
	}
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	const activeIdx = active === null ? -1 : active.run.phaseIndex;
	return summary.phases.map((phase, idx) => {
		let state: PhaseState = "pending";
		if (activeIdx >= 0) {
			if (idx < activeIdx) state = "done";
			else if (idx === activeIdx) state = "current";
			else state = "pending";
		}
		return { phase, state };
	});
}

/**
 * Steps of the currently displayed run (held or cursor-owning), with playback
 * states. Only the active run's steps are listed — rollback runs never replay
 * earlier runs' steps.
 */
export function visibleRunSteps(
	summary: NormalizedSummary,
	model: PlaybackModel,
	cursor: number,
	heldRunIndex: number | null = null,
): Array<{ step: Step; state: StepState; global: number }> {
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	if (active === null) return [];
	return active.run.steps.map((step, stepIndex) => {
		const global = active.start + stepIndex;
		let state: StepState = "pending";
		if (global < cursor) state = "done";
		else if (global === cursor && cursor < model.total) state = "running";
		return { step, state, global };
	});
}

/**
 * Artifacts revealed so far for the currently displayed run: an artifact
 * appears once at least one of its producing steps has completed. During the
 * post-run hold the completed run stays displayed (cursor at its end), so the
 * last step's outputs are still visible before the panel switches.
 * Artifacts referenced by no step appear after the first step.
 */
export function visibleRunArtifacts(
	summary: NormalizedSummary,
	model: PlaybackModel,
	cursor: number,
	heldRunIndex: number | null = null,
): VisibleArtifact[] {
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	if (active === null) return [];
	const producers = new Map<string, number[]>(); // artifactId → [global step indexes]
	active.run.steps.forEach((step, stepIndex) => {
		const global = active.start + stepIndex;
		step.artifactIds.forEach((id) => {
			if (!producers.has(id)) producers.set(id, []);
			producers.get(id)!.push(global);
		});
	});
	const seen = new Set<string>();
	const out: VisibleArtifact[] = [];
	active.run.artifacts.forEach((artifact) => {
		if (seen.has(artifact.id)) return;
		const producedBy = producers.get(artifact.id) ?? null;
		if (producedBy === null) {
			// no producing step → visible once the run has made progress
			if (cursor > active.start) {
				seen.add(artifact.id);
				out.push({ artifact, producedByStep: null });
			}
			return;
		}
		if (producedBy.some((g) => g < cursor)) {
			seen.add(artifact.id);
			out.push({ artifact, producedByStep: producedBy[0] });
		}
	});
	return out;
}

/**
 * Metrics of the currently displayed run. Reveal rule: data results appear
 * only AFTER the run has fully executed (per-stage statistics are shown once
 * the stage finishes). While steps are running the set is empty so the panel
 * hides; during the post-run hold — or at the very end — they are returned.
 */
export function visibleRunMetrics(
	summary: NormalizedSummary,
	model: PlaybackModel,
	cursor: number,
	heldRunIndex: number | null = null,
): Metric[] {
	const active = resolveActiveRun(model, cursor, heldRunIndex);
	if (active === null) return [];
	if (heldRunIndex !== null || cursor >= active.end) return active.run.metrics;
	return [];
}

/** Effective hold duration honoring speed + reduced motion. */
export function holdDurationOf(speed: number, reducedMotion = false): number {
	if (reducedMotion) return 0;
	return Math.max(MIN_DURATION, Math.round(HOLD_DURATION / Math.max(1, speed)));
}

/** Step display duration honoring per-step override + speed + reduced motion. */
export function durationOf(step: Step, speed: number, reducedMotion = false): number {
	const base = reducedMotion ? 0 : step.replayDuration > 0 ? step.replayDuration : DEFAULT_DURATION;
	return Math.max(MIN_DURATION, Math.round(base / Math.max(1, speed)));
}

/** Overall progress 0..100 (completed steps / all steps over the timeline). */
export function progressOf(model: PlaybackModel, cursor: number): number {
	if (model.total === 0) return 100;
	return Math.min(100, Math.floor((cursor * 100) / model.total));
}

/**
 * Choose a jump target for a business phase in the top bar.
 * A phase may run several times (dev① dev② …). When the second (or later)
 * run has already started, prefer that most recent occurrence; otherwise
 * position at the first run of the phase.
 */
export function jumpTargetForPhase(
	summary: NormalizedSummary,
	model: PlaybackModel,
	phaseId: string,
	cursor: number,
): JumpTarget | null {
	if (typeof phaseId !== "string" || phaseId === "") return null;
	const runsOfPhase = model.runs.filter((r) => r.run.phaseId === phaseId);
	if (runsOfPhase.length === 0) return null;
	// most recent occurrence whose start has been reached
	let chosen = runsOfPhase[0];
	for (const r of runsOfPhase) {
		if (r.start <= cursor) chosen = r;
	}
	return { run: chosen.run, runIndex: chosen.runIndex, stepIndex: 0 };
}

/** Global step index of a run's first step, or the run's end when empty. */
export function runStartGlobal(model: PlaybackModel, runIndex: number): number | null {
	const r = model.runs[runIndex];
	if (r === undefined) return null;
	return r.stepCount > 0 ? r.start : r.end;
}

/** Human one-liner for a phase chip at a given state. */
export function phaseStateLabel(state: PhaseState): string {
	return state === "done" ? "done" : state === "current" ? "current" : "pending";
}

/** Whether a run is a rollback/reentry transition run. */
export function isTransitionRun(run: TimelineRun): boolean {
	return run.type === "rollback" || run.type === "reentry";
}
