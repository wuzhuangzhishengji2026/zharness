/**
 * 动态工作流引擎测试:全部用 stub 执行器(子代理/命令),不派生真实进程。
 *
 * 覆盖:typed ask 的 JSON 契约、phase/log/report/artifact、world.run 的
 * 退出码语义、重复 agent 名、参数校验、中止语义、运行记录与 journal。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	listWorkflowRuns,
	startWorkflowRun,
	validateWorkflowArgs,
	type WorkflowEngineOptions,
} from "../src/core/workflow/engine.js";
import { extractInterfaces, extractJsonResult } from "../src/core/workflow/interfaces.js";
import { loadSopFile } from "../src/core/sop.js";
import { fileURLToPath } from "node:url";
import type { SubagentAskRequest, SubagentExecutor, WorkflowCommandExecutor } from "../src/core/workflow/types.js";

const tempRoots: string[] = [];

function makeTempDir(prefix = "zharness-wf-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop()!;
		rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
	}
});

/** 记录全部请求并按处理器应答的 stub 子代理执行器。 */
function stubExecutor(handler: (req: SubagentAskRequest) => string): SubagentExecutor & { requests: SubagentAskRequest[] } {
	const requests: SubagentAskRequest[] = [];
	return {
		requests,
		async ask(req) {
			requests.push(req);
			return handler(req);
		},
		async dispose() {},
		async disposeAll() {},
	};
}

function okCommandExecutor(): WorkflowCommandExecutor {
	return {
		async run(command, args) {
			return { exitCode: 0, stdout: `ran ${command} ${args.join(" ")}`.trim(), stderr: "" };
		},
	};
}

function engineOptions(
	cwd: string,
	agentDir: string,
	executor: SubagentExecutor,
	commandExecutor?: WorkflowCommandExecutor,
): WorkflowEngineOptions {
	return { subagentExecutor: executor, commandExecutor: commandExecutor ?? okCommandExecutor(), cwd, agentDir };
}

async function runScript(
	scriptSource: string,
	options?: {
		args?: Record<string, unknown>;
		argDefs?: Array<{ name: string; required?: boolean; default?: string }>;
		handler?: (req: SubagentAskRequest) => string;
		commandExecutor?: WorkflowCommandExecutor;
	},
) {
	const cwd = makeTempDir();
	const agentDir = makeTempDir("zharness-wf-agent-");
	const executor = stubExecutor(options?.handler ?? (() => "ok"));
	const handle = await startWorkflowRun(
		{
			slug: "test-sop",
			name: "测试工作流",
			scriptSource,
			args: options?.args,
			argDefs: options?.argDefs,
		},
		engineOptions(cwd, agentDir, executor, options?.commandExecutor),
	);
	const outcome = await handle.promise;
	return { outcome, cwd, agentDir, executor };
}

describe("startWorkflowRun", () => {
	it(
		"runs phases, typed asks, reports and artifacts end to end",
		async () => {
			const script = [
				"interface Answer {",
				"  /** 一句话结论 */",
				"  conclusion: string;",
				"}",
				'phase("提问");',
				'const a = await agent("调研员", "你是严谨的调研员").ask<Answer>("回答问题", { of: "Answer" });',
				'log("拿到答案");',
				"report({ ok: a.conclusion === \"ok\" }, \"t\");",
				'phase("落盘");',
				'await artifact.markdown("summary", "# " + a.conclusion, { title: "小结", primary: true });',
				'return { conclusion: "done: " + a.conclusion };',
			].join("\n");
			const { outcome, cwd, agentDir, executor } = await runScript(script, {
				handler: () => '说明一句\n```json\n{"conclusion":"ok"}\n```',
			});

			expect(outcome.status).toBe("completed");
			expect(outcome.result).toEqual({ conclusion: "done: ok" });
			expect(outcome.phases).toEqual(["提问", "落盘"]);
			expect(outcome.reports).toEqual([{ item: { ok: true }, tag: "t" }]);
			expect(outcome.artifacts).toHaveLength(1);
			expect(outcome.artifacts[0].id).toBe("summary");
			expect(outcome.artifacts[0].primary).toBe(true);
			expect(outcome.artifacts[0].path).toMatch(/^out\/sop-runs\/run-[^/]+\/summary\.md$/);
			expect(outcome.conclusion).toBe("done: ok");

			// 产物文件真实写出;journal 记录了关键事件;首个 ask 注入了角色与 JSON 契约。
			expect(existsSync(join(cwd, "out", "sop-runs", outcome.runId, "summary.md"))).toBe(true);
			const journal = readFileSync(join(agentDir, "sop-runs", outcome.runId, "journal.jsonl"), "utf-8");
			expect(journal).toContain('"t":"phase"');
			expect(journal).toContain('"t":"report"');
			expect(journal).toContain('"t":"run_completed"');
			expect(executor.requests).toHaveLength(1);
			expect(executor.requests[0].instructions).toContain("你是严谨的调研员");
			expect(executor.requests[0].instructions).toContain("结果契约");
			expect(executor.requests[0].instructions).toContain("interface Answer");
		},
		20_000,
	);

	it(
		"returns trimmed text for untyped asks",
		async () => {
			const { outcome } = await runScript('const t = await agent().ask("hi");\nreturn { got: t };', {
				handler: () => "  plain reply  ",
			});
			expect(outcome.status).toBe("completed");
			expect(outcome.result).toEqual({ got: "plain reply" });
		},
		20_000,
	);

	it(
		"fails the run on duplicate agent names",
		async () => {
			const { outcome } = await runScript('agent("a");\nagent("a");\nreturn {};');
			expect(outcome.status).toBe("errored");
			expect(outcome.error).toContain("duplicate agent name");
		},
		20_000,
	);

	it(
		"fails the run when a typed ask returns no parsable json block",
		async () => {
			const script = 'interface A { x: string; }\nconst a = await agent("w").ask<A>("go", { of: "A" });\nreturn a;';
			const { outcome } = await runScript(script, { handler: () => "没有 json 的回答" });
			expect(outcome.status).toBe("errored");
			expect(outcome.error).toContain("JSON");
		},
		20_000,
	);

	it(
		"treats world.run exit codes as values, not exceptions",
		async () => {
			const script = [
				'const r = await world.run("check", ["--all"]);',
				'if (r.exitCode !== 0) { return { conclusion: "gate failed" }; }',
				'return { conclusion: "gate passed: " + r.stdout.trim() };',
			].join("\n");
			const failing: WorkflowCommandExecutor = {
				async run() {
					return { exitCode: 1, stdout: "", stderr: "boom" };
				},
			};
			const { outcome } = await runScript(script, { commandExecutor: failing });
			expect(outcome.result).toEqual({ conclusion: "gate failed" });
			expect(outcome.status).toBe("completed");
		},
		20_000,
	);

	it(
		"rejects the start when a required argument is missing",
		async () => {
			const cwd = makeTempDir();
			const agentDir = makeTempDir("zharness-wf-agent-");
			await expect(
				startWorkflowRun(
					{ slug: "s", name: "n", scriptSource: "return 1;", args: {}, argDefs: [{ name: "task", required: true }] },
					engineOptions(cwd, agentDir, stubExecutor(() => "ok")),
				),
			).rejects.toThrow(/invalid arguments.*task/);
		},
		20_000,
	);

	it(
		"marks a stopped run as stopped (not errored) and lists it",
		async () => {
			const script = 'phase("等待");\nawait world.run("sleep", ["60"]);\nreturn { conclusion: "never" };';
			const aborting: WorkflowCommandExecutor = {
				run(_command, _args, options) {
					return new Promise((_resolve, reject) => {
						const signal = options?.signal;
						if (signal) {
							if (signal.aborted) {
								reject(new Error("aborted"));
								return;
							}
							signal.addEventListener("abort", () => reject(new Error("aborted")));
						} else {
							setTimeout(() => reject(new Error("timeout")), 5000);
						}
					});
				},
			};
			const cwd = makeTempDir();
			const agentDir = makeTempDir("zharness-wf-agent-");
			const handle = await startWorkflowRun(
				{ slug: "s", name: "n", scriptSource: script },
				engineOptions(cwd, agentDir, stubExecutor(() => "ok"), aborting),
			);
			handle.stop("user");
			const outcome = await handle.promise;
			expect(outcome.status).toBe("stopped");
			expect(outcome.stopReason).toBe("user");

			const runs = listWorkflowRuns(agentDir);
			expect(runs).toHaveLength(1);
			expect(runs[0].status).toBe("stopped");
			expect(runs[0].slug).toBe("s");
		},
		20_000,
	);
});

describe("builtin dynamic-task SOP (smoke run through the engine)", () => {
	it(
		"executes the shipped script with stub subagents end to end",
		async () => {
			const sopPath = fileURLToPath(new URL("../src/builtin-sops/dynamic-task/SOP.md", import.meta.url));
			const { sop, errors } = loadSopFile(sopPath);
			expect(errors).toEqual([]);
			expect(sop?.kind).toBe("dynamic");

			// 按 ask 的接口契约回放子代理:Plan → 两个带依赖的子任务;
			// SubTaskOutcome → 完成;Review → confirmed。
			const handler = (req: SubagentAskRequest): string => {
				if (req.instructions.includes("interface Plan")) {
					const plan = {
						understanding: "先扫工作区,再分两步完成。",
						proceed: true,
						subtasks: [
							{ id: "t1", title: "第一步", detail: "做 A", dependsOn: [] },
							{ id: "t2", title: "第二步", detail: "做 B(依赖 A)", dependsOn: ["t1"] },
						],
					};
					return "计划如下\n```json\n" + JSON.stringify(plan) + "\n```";
				}
				if (req.instructions.includes("interface SubTaskOutcome")) {
					const id = req.instructions.includes("【子任务 t2】") ? "t2" : "t1";
					const outcome = { id, ok: true, summary: "完成了", evidence: "改了 a.ts", deliverables: ["a.ts"] };
					return "结果如下\n```json\n" + JSON.stringify(outcome) + "\n```";
				}
				const review = { verdict: "confirmed", note: "现场与声明一致" };
				return "复核如下\n```json\n" + JSON.stringify(review) + "\n```";
			};

			const { outcome, executor } = await runScript(sop!.scriptSource!, {
				args: { task: "测试任务", constraints: "" },
				handler,
			});

			expect(outcome.status).toBe("completed");
			// 规划员 1 次 + 两波各一个子任务的(执行 + 独立复核),共 5 个 ask。
			expect(executor.requests).toHaveLength(5);
			expect(outcome.reports).toHaveLength(2);
			const names = executor.requests.map((r) => r.actorName);
			expect(names).toEqual(["规划员", "执行-t1", "复核-t1", "执行-t2", "复核-t2"]);
			const result = outcome.result as { conclusion: string; findings: unknown[] };
			expect(result.conclusion).toContain("全部完成");
			expect(result.findings).toHaveLength(2);
			expect(outcome.artifacts[0]?.primary).toBe(true);
			expect(outcome.artifacts[0]?.path).toMatch(/report\.md$/);
		},
		30_000,
	);
});

describe("validateWorkflowArgs", () => {
	it("fills defaults and reports missing required args", () => {
		const { values, errors } = validateWorkflowArgs(
			[
				{ name: "task", required: true, description: "任务描述" },
				{ name: "depth", default: "standard" },
			],
			{ depth: "deep" },
		);
		expect(errors).toEqual(['missing required argument "task" (任务描述)']);
		expect(values).toEqual({ depth: "deep" });
	});
});

describe("extractInterfaces / extractJsonResult", () => {
	it("extracts interfaces with nested braces and comments", () => {
		const source = [
			"// leading comment",
			"interface Plan {",
			"  /** 子任务 */",
			"  subtasks: Array<{ id: string; tags: string[]; nested: { deep: boolean } }>;",
			"  proceed?: boolean;",
			"}",
			"const x = '{ not an interface }';",
		].join("\n");
		const map = extractInterfaces(source);
		expect(map.has("Plan")).toBe(true);
		expect(map.get("Plan")).toContain("subtasks");
		expect(map.get("Plan")).toContain("nested");
	});

	it("prefers the last json fence and falls back to whole-text json", () => {
		expect(extractJsonResult('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ a: 1 });
		expect(extractJsonResult('{"a":2}')).toEqual({ a: 2 });
		expect(extractJsonResult("什么都没有")).toBeUndefined();
	});
});
