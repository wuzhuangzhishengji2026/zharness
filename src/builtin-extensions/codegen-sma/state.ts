/**
 * 流水线状态存储：.codegen/state.json。
 *
 * 记录只追加（records），构成磁盘上的审计轨迹；每次阶段推进即落盘，
 * 中断后可通过 /codegen status 查看断点。state.json 同时是阶段间的
 * 事实总线：只记录门禁验证过的信息（如 implement 的 changedFiles），
 * 不采信任何未经门禁的自我声明。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_ORDER, type StageId } from "./stages.js";

export interface StageRecord {
	stage: StageId;
	attempt: number;
	/** passed=门禁通过；failed=门禁/episode 失败；blocked=episode 主动报告阻塞；user-rejected=用户驳回（附意见） */
	status: "passed" | "failed" | "blocked" | "user-rejected";
	summary?: string;
	/** 失败/驳回证据（门禁日志尾部、用户意见等），重试时注入下一 episode */
	evidence?: string;
	/** implement 专属：门禁验证后的改动文件清单（供 audit/test 阶段消费） */
	changedFiles?: string[];
}

export interface PipelineState {
	goal: string;
	/** 当前阶段在 STAGE_ORDER 中的下标 */
	stageIndex: number;
	/** 当前阶段已尝试次数 */
	attempt: number;
	records: StageRecord[];
	startedAt: string;
	finishedAt?: string;
	/** aborted = 用户主动中止(保留断点,可 /codegen resume 恢复) */
	outcome?: "completed" | "blocked" | "abandoned" | "aborted";
}

const STATE_DIR_NAME = ".codegen";
const STATE_FILE_NAME = "state.json";

export function stateDir(cwd: string): string {
	return join(cwd, STATE_DIR_NAME);
}

/** 初始化新流水线（幂等创建 .codegen 目录） */
export function initPipeline(cwd: string, goal: string): PipelineState {
	mkdirSync(stateDir(cwd), { recursive: true });
	const state: PipelineState = {
		goal,
		stageIndex: 0,
		attempt: 0,
		records: [],
		startedAt: new Date().toISOString(),
	};
	saveState(cwd, state);
	return state;
}

export function loadState(cwd: string): PipelineState | null {
	const file = join(stateDir(cwd), STATE_FILE_NAME);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as PipelineState;
	} catch {
		return null;
	}
}

export function saveState(cwd: string, state: PipelineState): void {
	writeFileSync(join(stateDir(cwd), STATE_FILE_NAME), `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
}

/** 追加一条阶段记录并落盘（审计轨迹只增不改） */
export function appendRecord(cwd: string, state: PipelineState, record: StageRecord): void {
	state.records.push(record);
	saveState(cwd, state);
}

/** 最近一条指定阶段的 passed 记录（供后续阶段读取已验证事实） */
export function lastPassedRecord(state: PipelineState, stage: StageId): StageRecord | undefined {
	for (let i = state.records.length - 1; i >= 0; i--) {
		const record = state.records[i];
		if (record.stage === stage && record.status === "passed") return record;
	}
	return undefined;
}

/** 渲染给 /codegen status 的简报 */
export function formatStateBrief(state: PipelineState): string {
	const stageName = STAGE_ORDER[state.stageIndex] ?? "?";
	const lines = [
		`目标：${state.goal}`,
		`当前阶段：${stageName}（第 ${state.attempt} 次尝试）`,
		`结果：${state.outcome ?? "进行中"}`,
		`开始时间：${state.startedAt}`,
		`记录数：${state.records.length}`,
	];
	const failed = state.records.filter((r) => r.status !== "passed");
	if (failed.length > 0) {
		lines.push(`未通过记录：${failed.map((r) => `${r.stage}#${r.attempt}(${r.status})`).join(", ")}`);
	}
	return lines.join("\n");
}
