/**
 * knowledge-forge 定时任务生命周期。
 *
 * 插件启用时自动创建两个每日凌晨任务（知识沉淀 / 技能沉淀），禁用时移除。
 * 任务通过 tasks.json 与调度引擎交互：运行中的引擎靠目录 watcher 拾取
 * 外部写入（engine.syncFromDisk），所以本模块只做磁盘读写，不需要进程内
 * 引擎句柄——多个 sidecar 同时加载插件时靠「description 标记 + 名称」幂等
 * 去重，并发竞争最坏情况是重复条目，下一次 ensure 会自愈。
 *
 * 文件布局与 scheduler/store.ts 完全一致（main → <mainDir>/scheduler，
 * workspace → <agentDir>/workspaces/<id>/scheduler）；这里独立实现读写是
 * 为了让 mainDir/agentDir 可注入（测试用临时目录）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduledTask } from "@zharness/protocol";
import { getAgentDir, getMainDir } from "../../config.js";
import {
	KNOWLEDGE_TASK_MINUTE,
	SKILL_TASK_MINUTE,
	type KnowledgeForgeConfig,
	windowLabel,
} from "./config.js";
import { generateTaskId } from "../../core/scheduler/types.js";
import { DIGEST_PROMPT_MARKER } from "./scan.js";

/** 任务归属标记：写进 description，用于识别/清理本插件的任务。 */
export const TASK_MARKER = "[knowledge-forge]";
/** 派发 prompt 的开头标记（扫描侧据此剔除自身对话）。 */
export const DIGEST_PROMPT_TAG = DIGEST_PROMPT_MARKER;

export type DigestPurpose = "knowledge" | "skill";

export const KNOWLEDGE_TASK_NAME = "知识沉淀（knowledge-forge）";
export const SKILL_TASK_NAME = "技能沉淀（knowledge-forge）";

export interface TaskRoots {
	mainDir?: string;
	agentDir?: string;
}

interface TasksFile {
	schemaVersion: number;
	tasks: ScheduledTask[];
}

const SCHEMA_VERSION = 1;

function schedulerDir(scope: "main" | "workspace", workspaceId: string | undefined, roots: TaskRoots): string {
	if (scope === "main") return join(roots.mainDir ?? getMainDir(), "scheduler");
	if (!workspaceId) throw new Error("workspaceId is required for workspace scope");
	return join(roots.agentDir ?? getAgentDir(), "workspaces", workspaceId, "scheduler");
}

function readScopeTasks(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	roots: TaskRoots,
): ScheduledTask[] {
	const file = join(schedulerDir(scope, workspaceId, roots), "tasks.json");
	if (!existsSync(file)) return [];
	try {
		const raw = readFileSync(file, "utf-8");
		if (!raw.trim()) return [];
		const parsed = JSON.parse(raw) as TasksFile | ScheduledTask[];
		if (Array.isArray(parsed)) return parsed;
		return parsed.schemaVersion === SCHEMA_VERSION ? (parsed.tasks ?? []) : [];
	} catch {
		// 读不了（损坏/被锁）绝不当作「全部可删」——返回空会让 ensure 重建、
		// remove 误删。上层 ensure/remove 都以「读到才算数」为原则，这里返回
		// 空数组只影响本 scope 的操作，engine 侧 persist 有同样的保护。
		return [];
	}
}

function writeScopeTasks(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	tasks: ScheduledTask[],
	roots: TaskRoots,
): void {
	const dir = schedulerDir(scope, workspaceId, roots);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "tasks.json");
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, tasks } satisfies TasksFile, null, 2), "utf-8");
	if (existsSync(file)) {
		try {
			unlinkSync(file);
		} catch {
			/* Windows 上 rename 目标存在可能 EEXIST；删不掉仍尝试 rename */
		}
	}
	renameSync(tmp, file);
}

/** 本插件创建的任务识别谓词。 */
export function isKnowledgeForgeTask(task: ScheduledTask): boolean {
	return task.description?.includes(TASK_MARKER) === true;
}

function purposeOf(task: ScheduledTask): DigestPurpose | undefined {
	if (task.description?.includes(`${TASK_MARKER} knowledge`)) return "knowledge";
	if (task.description?.includes(`${TASK_MARKER} skill`)) return "skill";
	return undefined;
}

/**
 * 生成本插件的派发 prompt。这就是「与大模型交互」的契约：凌晨任务触发后，
 * 调度器把 prompt 派发进一个新会话，由主模型按步骤调用 scan/save 工具完成
 * 分析与沉淀。
 */
export function buildDigestPrompt(purpose: DigestPurpose, config: KnowledgeForgeConfig): string {
	const window = windowLabel(config.window);
	if (purpose === "knowledge") {
		return [
			`${DIGEST_PROMPT_MARKER} 知识沉淀任务】`,
			`请沉淀过去 ${window} 内会话中有长期价值的知识：`,
			"1. 调用 knowledge_scan 工具（kind=\"knowledge\"）获取会话材料；",
			"2. 从中提炼有复用价值的知识：事实结论、踩坑与解法、决策依据、领域/项目约束等；",
			'3. 对每条值得沉淀的知识调用 knowledge_save（kind="knowledge"，给出 category、title、content、tags、source_sessions）——content 必须自包含、脱离原会话也能看懂并直接复用，不要空洞的口号；',
			"4. 没有值得沉淀的内容就明确说明并结束，不要硬凑条目；",
			"5. 最后用 3-5 行总结：沉淀了几条、哪些类目、各自一句话亮点。",
		].join("\n");
	}
	return [
		`${DIGEST_PROMPT_MARKER} 技能沉淀任务】`,
		`请沉淀过去 ${window} 内会话中有长期价值的技能：`,
		"1. 调用 knowledge_scan 工具（kind=\"skill\"）获取会话材料；",
		"2. 从中提炼可复用的操作能力：命令组合、配置步骤、排查流程、工具用法、高效工作流等；",
		'3. 对每条值得沉淀的技能调用 knowledge_save（kind="skill"，给出 category、title、content、tags、source_sessions）——content 要写成可照着执行的步骤/命令，脱离原会话也能直接用；',
		"4. 没有值得沉淀的内容就明确说明并结束，不要硬凑条目；",
		"5. 最后用 3-5 行总结：沉淀了几条、哪些类目、各自一句话亮点。",
	].join("\n");
}

interface TaskSpec {
	purpose: DigestPurpose;
	name: string;
	hour: number;
	minute: number;
	description: string;
}

function taskSpecs(config: KnowledgeForgeConfig): TaskSpec[] {
	return [
		{
			purpose: "knowledge",
			name: KNOWLEDGE_TASK_NAME,
			hour: config.knowledgeHour,
			minute: KNOWLEDGE_TASK_MINUTE,
			description: `${TASK_MARKER} knowledge · 每日扫描会话沉淀知识`,
		},
		{
			purpose: "skill",
			name: SKILL_TASK_NAME,
			hour: config.skillHour,
			minute: SKILL_TASK_MINUTE,
			description: `${TASK_MARKER} skill · 每日扫描会话沉淀技能`,
		},
	];
}

export interface EnsureTasksOptions extends TaskRoots {
	scope: "main" | "workspace";
	workspaceId?: string;
	config: KnowledgeForgeConfig;
	now?: number;
}

export interface EnsureTasksResult {
	created: string[];
	updated: string[];
	removedDuplicates: string[];
}

/**
 * 确保两个定时任务存在且与配置一致（幂等）：
 *   - 缺失 → 创建；
 *   - 触发小时变化 → 更新 schedule；
 *   - 同 purpose 重复（并发写竞争残留）→ 保留最早的，删除多余的。
 */
export function ensureScheduledTasks(options: EnsureTasksOptions): EnsureTasksResult {
	const now = options.now ?? Date.now();
	const result: EnsureTasksResult = { created: [], updated: [], removedDuplicates: [] };
	const tasks = readScopeTasks(options.scope, options.workspaceId, options);
	const remaining: ScheduledTask[] = [];

	for (const spec of taskSpecs(options.config)) {
		const ours = tasks.filter((t) => isKnowledgeForgeTask(t) && purposeOf(t) === spec.purpose);
		if (ours.length === 0) {
			const task: ScheduledTask = {
				id: generateTaskId(),
				name: spec.name,
				prompt: buildDigestPrompt(spec.purpose, options.config),
				scope: options.scope,
				workspaceId: options.scope === "workspace" ? options.workspaceId : undefined,
				schedule: { mode: "daily", times: [{ hour: spec.hour, minute: spec.minute }] },
				enabled: true,
				description: spec.description,
				createdAt: now,
				updatedAt: now,
				createdBy: "user",
				runCount: 0,
				sessionTarget: { kind: "new", purpose: spec.purpose === "knowledge" ? "知识沉淀" : "技能沉淀" },
				concurrencyPolicy: "skip",
				timeoutMinutes: 90,
			};
			remaining.push(task);
			result.created.push(task.id);
			continue;
		}
		// 保留最早创建的，清掉并发竞争产生的重复。
		ours.sort((a, b) => a.createdAt - b.createdAt);
		const keep = ours[0]!;
		for (const dup of ours.slice(1)) {
			result.removedDuplicates.push(dup.id);
		}
		// schedule 与 prompt 跟随当前配置。
		const expectedTimes = [{ hour: spec.hour, minute: spec.minute }];
		const scheduleChanged = JSON.stringify(keep.schedule.times ?? []) !== JSON.stringify(expectedTimes);
		const expectedPrompt = buildDigestPrompt(spec.purpose, options.config);
		if (scheduleChanged || keep.prompt !== expectedPrompt) {
			const updated: ScheduledTask = {
				...keep,
				schedule: { ...keep.schedule, mode: "daily", times: expectedTimes },
				prompt: expectedPrompt,
				updatedAt: now,
			};
			remaining.push(updated);
			result.updated.push(updated.id);
			continue;
		}
		remaining.push(keep);
	}

	// 保留所有非本插件的任务。
	for (const t of tasks) {
		if (!isKnowledgeForgeTask(t)) remaining.push(t);
	}

	if (
		result.created.length > 0 ||
		result.updated.length > 0 ||
		result.removedDuplicates.length > 0
	) {
		writeScopeTasks(options.scope, options.workspaceId, remaining, options);
	}
	return result;
}

/** 移除所有 scope 里本插件的任务（禁用插件时调用）。返回删除的 id。 */
export function removeScheduledTasks(roots: TaskRoots = {}): string[] {
	const removed: string[] = [];
	const scopes: Array<{ scope: "main" | "workspace"; workspaceId?: string }> = [{ scope: "main" }];
	const wsRoot = join(roots.agentDir ?? getAgentDir(), "workspaces");
	if (existsSync(wsRoot)) {
		for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
			if (entry.isDirectory()) scopes.push({ scope: "workspace", workspaceId: entry.name });
		}
	}
	for (const s of scopes) {
		const tasks = readScopeTasks(s.scope, s.workspaceId, roots);
		const kept = tasks.filter((t) => {
			if (isKnowledgeForgeTask(t)) {
				removed.push(t.id);
				return false;
			}
			return true;
		});
		if (kept.length !== tasks.length) writeScopeTasks(s.scope, s.workspaceId, kept, roots);
	}
	return removed;
}

/** 找到本插件当前已建的任务（跨全部 scope，/knowledge status 用）。 */
export function findKnowledgeForgeTasks(roots: TaskRoots = {}): ScheduledTask[] {
	const out: ScheduledTask[] = [];
	out.push(...readScopeTasks("main", undefined, roots).filter(isKnowledgeForgeTask));
	const wsRoot = join(roots.agentDir ?? getAgentDir(), "workspaces");
	if (existsSync(wsRoot)) {
		for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			out.push(...readScopeTasks("workspace", entry.name, roots).filter(isKnowledgeForgeTask));
		}
	}
	return out;
}
