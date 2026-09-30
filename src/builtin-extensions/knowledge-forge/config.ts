/**
 * knowledge-forge 配置。
 *
 * 配置分两层：
 *   - 全局默认：<mainDir>/knowledge-forge/config.json
 *   - 项目覆盖：<projectCwd>/.zharness/knowledge-forge.json（可选，仅覆盖出现的字段）
 *
 * 有效配置 = 全局默认 ← 项目覆盖。所有字段可注入根目录，便于测试。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMainDir } from "../../config.js";

/** 回看窗口：一天（默认）/一周/一月。 */
export type ScanWindow = "day" | "week" | "month";

/** 沉淀库位置：全局目录（main）或项目目录（.zharness）。 */
export type LibraryDestination = "global" | "project";

export interface KnowledgeForgeConfig {
	/** 扫描回看的会话时间窗。默认 "day"。 */
	window: ScanWindow;
	/** 沉淀产物写到全局目录还是项目目录。默认 "global"。 */
	destination: LibraryDestination;
	/** 知识沉淀任务的每日触发小时（0-23）。默认 2（凌晨）。 */
	knowledgeHour: number;
	/** 技能沉淀任务的每日触发小时（0-23）。默认 3（凌晨）。 */
	skillHour: number;
}

export const DEFAULT_CONFIG: KnowledgeForgeConfig = {
	window: "day",
	destination: "global",
	knowledgeHour: 2,
	skillHour: 3,
};

/** 知识任务的固定分钟（避开整点，减少与其他整点任务撞车）。 */
export const KNOWLEDGE_TASK_MINUTE = 20;
/** 技能任务的固定分钟。 */
export const SKILL_TASK_MINUTE = 50;

export function globalConfigPath(mainDir: string = getMainDir()): string {
	return join(mainDir, "knowledge-forge", "config.json");
}

export function projectConfigPath(projectDir: string): string {
	return join(projectDir, ".zharness", "knowledge-forge.json");
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8");
		if (!raw.trim()) return undefined;
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		// 损坏的配置文件按「不存在」处理，绝不阻塞插件加载。
		return undefined;
	}
}

function writeJsonFile(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function clampHour(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
	return Math.floor(n);
}

/** 规范化任意输入为合法配置（未知字段回退默认值）。 */
export function normalizeConfig(input: Partial<Record<keyof KnowledgeForgeConfig, unknown>>): KnowledgeForgeConfig {
	return {
		window: input.window === "week" || input.window === "month" ? input.window : "day",
		destination: input.destination === "project" ? "project" : "global",
		knowledgeHour: clampHour(input.knowledgeHour, DEFAULT_CONFIG.knowledgeHour),
		skillHour: clampHour(input.skillHour, DEFAULT_CONFIG.skillHour),
	};
}

export interface LoadConfigOptions {
	mainDir?: string;
	/** 项目目录（通常为 sidecar 的 cwd）；不给则不应用项目覆盖。 */
	projectDir?: string;
}

/** 读取有效配置：全局默认 + 项目覆盖。 */
export function loadConfig(options: LoadConfigOptions = {}): KnowledgeForgeConfig {
	const globalRaw = readJsonFile(globalConfigPath(options.mainDir)) ?? {};
	const projectRaw = options.projectDir ? readJsonFile(projectConfigPath(options.projectDir)) ?? {} : {};
	return normalizeConfig({ ...DEFAULT_CONFIG, ...globalRaw, ...projectRaw });
}

/** 覆写全局配置（整体写入，保留未知字段无意义——字段集合就是全部状态）。 */
export function saveGlobalConfig(config: KnowledgeForgeConfig, mainDir: string = getMainDir()): void {
	writeJsonFile(globalConfigPath(mainDir), normalizeConfig(config));
}

/** 覆写项目配置（只写显式给出的字段）。 */
export function saveProjectConfig(patch: Partial<KnowledgeForgeConfig>, projectDir: string): void {
	writeJsonFile(projectConfigPath(projectDir), patch);
}

/** 窗口对应的毫秒数。 */
export function windowMs(window: ScanWindow): number {
	switch (window) {
		case "week":
			return 7 * 24 * 3600_000;
		case "month":
			return 30 * 24 * 3600_000;
		case "day":
		default:
			return 24 * 3600_000;
	}
}

/** 窗口的中文描述（写进任务 prompt）。 */
export function windowLabel(window: ScanWindow): string {
	switch (window) {
		case "week":
			return "7 天";
		case "month":
			return "30 天";
		case "day":
		default:
			return "1 天";
	}
}
