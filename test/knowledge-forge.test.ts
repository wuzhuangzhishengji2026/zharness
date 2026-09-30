/**
 * knowledge-forge 内置扩展测试。
 *
 * 覆盖：
 * 1. config —— 默认值、全局保存、项目覆盖、非法值规范化
 * 2. scan —— 时间窗过滤、脚手架会话剔除、自反馈消息剔除、附件计数、渲染
 * 3. library —— 落盘/frontmatter/INDEX、同名去重、统计
 * 4. tasks —— ensure 幂等创建、小时变更更新、并发重复自愈、remove 清理、
 *    prompt 携带窗口描述
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { ensureWorkspaceMeta, getEventDatabasePath } from "../src/core/event-store/workspace.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { SessionFileStoreManager } from "../src/core/event-store/session-files.js";
import type { ScheduledTask } from "@zharness/protocol";
import {
	DEFAULT_CONFIG,
	loadConfig,
	saveGlobalConfig,
	saveProjectConfig,
	windowLabel,
	windowMs,
} from "../src/builtin-extensions/knowledge-forge/config.js";
import {
	renderScanResult,
	scanSessions,
	DIGEST_PROMPT_MARKER,
} from "../src/builtin-extensions/knowledge-forge/scan.js";
import {
	libraryStats,
	resolveLibraryRoot,
	saveEntry,
} from "../src/builtin-extensions/knowledge-forge/library.js";
import {
	buildDigestPrompt,
	ensureScheduledTasks,
	findKnowledgeForgeTasks,
	isKnowledgeForgeTask,
	removeScheduledTasks,
} from "../src/builtin-extensions/knowledge-forge/tasks.js";

let mainDir: string;
let agentDir: string;
let projectDir: string;

function readTasksFile(scope: "main" | "workspace", workspaceId?: string): ScheduledTask[] {
	const dir =
		scope === "main"
			? join(mainDir, "scheduler")
			: join(agentDir, "workspaces", workspaceId ?? "", "scheduler");
	const file = join(dir, "tasks.json");
	if (!existsSync(file)) return [];
	return (JSON.parse(readFileSync(file, "utf-8")) as { tasks: ScheduledTask[] }).tasks;
}

beforeEach(() => {
	mainDir = mkdtempSync(join(tmpdir(), "kf-main-"));
	agentDir = mkdtempSync(join(tmpdir(), "kf-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "kf-project-"));
});

afterEach(() => {
	for (const dir of [mainDir, agentDir, projectDir]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("knowledge-forge config", () => {
	it("默认配置：day / global / 2 点与 3 点", () => {
		const config = loadConfig({ mainDir, projectDir });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config).toMatchObject({ window: "day", destination: "global", knowledgeHour: 2, skillHour: 3 });
	});

	it("全局配置保存后可读回", () => {
		saveGlobalConfig({ ...DEFAULT_CONFIG, window: "week", destination: "project" }, mainDir);
		const config = loadConfig({ mainDir, projectDir });
		expect(config.window).toBe("week");
		expect(config.destination).toBe("project");
	});

	it("项目覆盖优先于全局配置", () => {
		saveGlobalConfig({ ...DEFAULT_CONFIG, window: "week" }, mainDir);
		saveProjectConfig({ window: "month" }, projectDir);
		const config = loadConfig({ mainDir, projectDir });
		expect(config.window).toBe("month");
		// 未覆盖的字段保持全局值。
		expect(config.destination).toBe("global");
	});

	it("非法字段回退默认值（损坏文件按缺失处理）", () => {
		saveGlobalConfig({ ...DEFAULT_CONFIG, knowledgeHour: 99, window: "year" as never }, mainDir);
		const config = loadConfig({ mainDir, projectDir });
		expect(config.knowledgeHour).toBe(2);
		expect(config.window).toBe("day");
	});

	it("window 换算：day/week/month", () => {
		expect(windowMs("day")).toBe(24 * 3600_000);
		expect(windowMs("week")).toBe(7 * 24 * 3600_000);
		expect(windowMs("month")).toBe(30 * 24 * 3600_000);
		expect(windowLabel("week")).toContain("7");
	});
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe("knowledge-forge scan", () => {
	it("提取窗口内的用户消息/助手结论/工具统计，剔除脚手架与自反馈消息", () => {
		ensureWorkspaceMeta("ws-a", "/project/a", agentDir);
		// v2 每会话一库：经 manager 播种，事件落进活跃会话自己的库。
		const files = new SessionFileStoreManager("ws-a", agentDir, { cwd: "/project/a" });
		const manager = new SessionManager(files);
		try {
			const s1 = manager.getActiveSession().getDescriptor();
			const emit = (partial: Parameters<typeof files.active.append>[0]): void => {
				files.active.append(partial);
			};
			emit({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "npm 装依赖总失败怎么办", images: [{ type: "image", data: "x" }] },
			});
			emit({
				actor_id: "coder_agent",
				type: "AGENT_MESSAGE_END",
				payload: { content: "用 npm install --ignore-scripts 绕过 node-pty 编译失败" },
			});
			emit({
				actor_id: "coder_agent",
				type: "TOOL_EXECUTION_END",
				payload: { toolName: "bash", isError: false },
			});
			emit({
				actor_id: "coder_agent",
				type: "TOOL_EXECUTION_END",
				payload: { toolName: "bash", isError: true },
			});

			// 定时任务脚手架会话：不进扫描结果。
			const scaffold = manager.createSession("user_explicit", "scheduled: nightly report");
			files.setActive(scaffold.session_id);
			emit({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "scheduled dispatch content" },
			});

			// 本插件自己的派发消息（落在普通会话里）：剔除，防自反馈。
			const s2 = manager.createSession("user_explicit", "手动会话");
			emit({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: `${DIGEST_PROMPT_MARKER} 知识沉淀任务】请沉淀过去 1 天…` },
			});

			const result = scanSessions({
				windowMs: 24 * 3600_000,
				agentDir,
				workspaceIds: ["ws-a"],
			});
			expect(result.conversations).toHaveLength(1);
			const convo = result.conversations[0]!;
			expect(convo.sessionId).toBe(s1.session_id);
			expect(convo.userMessages[0]).toContain("npm 装依赖");
			expect(convo.assistantConclusions[0]).toContain("--ignore-scripts");
			expect(convo.toolCalls).toBe(2);
			expect(convo.toolErrors).toBe(1);
			expect(convo.topTools[0]).toContain("bash");
			expect(convo.imagesAttached).toBe(1);
			// 手动会话只剩自反馈消息 → 整体被剔除后不出现。
			expect(result.conversations.some((c) => c.sessionId === s2.session_id)).toBe(false);

			const text = renderScanResult(result, "1 天");
			expect(text).toContain("npm 装依赖");
			expect(text).toContain("附件图片 1 张");
		} finally {
			manager.dispose();
		}
	});

	it("窗口外的会话不进结果", () => {
		ensureWorkspaceMeta("ws-old", "/project/old", agentDir);
		const files = new SessionFileStoreManager("ws-old", agentDir, { cwd: "/project/old" });
		const manager = new SessionManager(files);
		try {
			manager.getActiveSession().getDescriptor();
			files.active.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "不久前的对话" },
			});

			// 扫描时刻放在 10 天后：事件落在窗口之外。
			const result = scanSessions({
				windowMs: 24 * 3600_000,
				agentDir,
				workspaceIds: ["ws-old"],
				now: Date.now() + 10 * 24 * 3600_000,
			});
			expect(result.conversations).toHaveLength(0);
		} finally {
			manager.dispose();
		}
	});
});

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

describe("knowledge-forge library", () => {
	it("保存条目：frontmatter + 正文 + INDEX，重复标题去重", () => {
		const root = resolveLibraryRoot({ destination: "global", mainDir });
		const first = saveEntry(
			{
				kind: "knowledge",
				category: "环境与构建",
				title: "npm install --ignore-scripts 绕过 node-pty 编译失败",
				content: "在此机器上 node-pty 原生编译会 0xC0000005 崩溃，装依赖统一用 npm install --ignore-scripts。",
				tags: ["npm", "环境"],
				sourceSessions: ["sess_1"],
			},
			root,
		);
		expect(first.status).toBe("saved");
		const body = readFileSync(first.path, "utf-8");
		expect(body).toContain("kind: knowledge");
		expect(body).toContain("category: 环境与构建");
		expect(body).toContain("tags: [knowledge-forge, npm, 环境]");
		expect(body).toContain("# npm install --ignore-scripts 绕过 node-pty 编译失败");

		// 同类目同名 → duplicate，不覆盖。
		const dup = saveEntry(
			{
				kind: "knowledge",
				category: "环境与构建",
				title: "npm install --ignore-scripts 绕过 node-pty 编译失败",
				content: "不同内容也不该写第二条。",
			},
			root,
		);
		expect(dup.status).toBe("duplicate");
		if (dup.status === "duplicate") expect(dup.path).toBe(first.path);

		// 不同类目同名不算重复。
		const other = saveEntry(
			{ kind: "skill", category: "工作流", title: "npm install --ignore-scripts 绕过 node-pty 编译失败", content: "步骤…" },
			root,
		);
		expect(other.status).toBe("saved");

		const index = readFileSync(join(root, "INDEX.md"), "utf-8");
		expect(index).toContain("知识 · 环境与构建");
		expect(index).toContain("技能 · 工作流");

		const stats = libraryStats(root);
		expect(stats.knowledge.entries).toBe(1);
		expect(stats.skills.entries).toBe(1);
		expect(stats.knowledge.categories).toBe(1);
	});

	it("项目模式落到 <projectDir>/.zharness/knowledge-forge/library", () => {
		const root = resolveLibraryRoot({ destination: "project", projectDir });
		expect(root).toBe(join(projectDir, ".zharness", "knowledge-forge", "library"));
		const result = saveEntry({ kind: "skill", category: "排查", title: "查协议链接", content: "ls node_modules/@zharness" }, root);
		expect(result.status).toBe("saved");
		expect(existsSync(join(root, "skills", "排查"))).toBe(true);
	});

	it("空标题/空正文返回 invalid", () => {
		const root = resolveLibraryRoot({ destination: "global", mainDir });
		expect(saveEntry({ kind: "knowledge", category: "x", title: "  ", content: "y" }, root).status).toBe("invalid");
		expect(saveEntry({ kind: "knowledge", category: "x", title: "t", content: " " }, root).status).toBe("invalid");
	});
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

describe("knowledge-forge tasks", () => {
	it("ensure 创建两个任务，幂等，小时变更会更新 schedule", () => {
		const first = ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		expect(first.created).toHaveLength(2);
		expect(first.updated).toHaveLength(0);

		const tasks = readTasksFile("main");
		expect(tasks.filter(isKnowledgeForgeTask)).toHaveLength(2);
		const knowledge = tasks.find((t) => t.description?.includes("knowledge"))!;
		expect(knowledge.schedule).toMatchObject({ mode: "daily", times: [{ hour: 2, minute: 20 }] });
		expect(knowledge.prompt).toContain("knowledge_scan");
		expect(knowledge.prompt).toContain("1 天");
		expect(knowledge.sessionTarget).toEqual({ kind: "new", purpose: "知识沉淀" });
		expect(knowledge.enabled).toBe(true);

		// 再次 ensure：无变化。
		const second = ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		expect(second.created).toHaveLength(0);
		expect(second.updated).toHaveLength(0);
		expect(readTasksFile("main")).toHaveLength(2);

		// 改小时 → schedule 与 prompt 更新，任务数量不变。
		const third = ensureScheduledTasks({
			scope: "main",
			config: { ...DEFAULT_CONFIG, window: "week", knowledgeHour: 4 },
			mainDir,
			agentDir,
		});
		expect(third.updated).toHaveLength(2);
		const updated = readTasksFile("main");
		expect(updated).toHaveLength(2);
		const updatedKnowledge = updated.find((t) => t.description?.includes("knowledge"))!;
		expect(updatedKnowledge.schedule.times).toEqual([{ hour: 4, minute: 20 }]);
		expect(updatedKnowledge.prompt).toContain("7 天");
	});

	it("并发重复条目自愈：同 purpose 只保留最早的", () => {
		ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		// 模拟另一进程写入了重复任务。
		const tasks = readTasksFile("main");
		const extra = { ...tasks[0]!, id: "st_duplicate", createdAt: tasks[0]!.createdAt + 1 };
		writeFileSync(
			join(mainDir, "scheduler", "tasks.json"),
			JSON.stringify({ schemaVersion: 1, tasks: [...tasks, extra] }),
		);

		const result = ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		expect(result.removedDuplicates).toEqual(["st_duplicate"]);
		expect(readTasksFile("main")).toHaveLength(2);
	});

	it("workspace scope 建到对应工作区，remove 跨 scope 清理", () => {
		ensureScheduledTasks({ scope: "workspace", workspaceId: "ws-x", config: DEFAULT_CONFIG, mainDir, agentDir });
		expect(readTasksFile("workspace", "ws-x").filter(isKnowledgeForgeTask)).toHaveLength(2);

		ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		expect(findKnowledgeForgeTasks({ mainDir, agentDir })).toHaveLength(4);

		const removed = removeScheduledTasks({ mainDir, agentDir });
		expect(removed).toHaveLength(4);
		expect(readTasksFile("main")).toHaveLength(0);
		expect(readTasksFile("workspace", "ws-x")).toHaveLength(0);
	});

	it("remove 不动别人的任务", () => {
		ensureScheduledTasks({ scope: "main", config: DEFAULT_CONFIG, mainDir, agentDir });
		const tasks = readTasksFile("main");
		const foreign: ScheduledTask = {
			...tasks[0]!,
			id: "st_foreign",
			name: "用户自建任务",
			description: "用户手动创建",
		};
		writeFileSync(
			join(mainDir, "scheduler", "tasks.json"),
			JSON.stringify({ schemaVersion: 1, tasks: [...tasks, foreign] }),
		);

		removeScheduledTasks({ mainDir, agentDir });
		const remaining = readTasksFile("main");
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.id).toBe("st_foreign");
	});

	it("prompt 前缀与扫描剔除标记一致（防自反馈闭环）", () => {
		const knowledge = buildDigestPrompt("knowledge", DEFAULT_CONFIG);
		const skill = buildDigestPrompt("skill", DEFAULT_CONFIG);
		expect(knowledge.startsWith(DIGEST_PROMPT_MARKER)).toBe(true);
		expect(skill.startsWith(DIGEST_PROMPT_MARKER)).toBe(true);
		expect(knowledge).toContain("knowledge_save");
		expect(skill).toContain('"skill"');
	});
});
