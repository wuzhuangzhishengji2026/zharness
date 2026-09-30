import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findInstalledSop,
	loadSopFile,
	loadSopsFromDir,
	parseRunArgs,
	parseSopContent,
	renderSopWorkflowPrompt,
	renderTemplate,
} from "../src/core/sop.js";

const tempRoots: string[] = [];

function makeTempDir(prefix = "zharness-sop-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

const VALID_SOP = `---
name: demo
description: A demo SOP for tests
version: 1.2.0
author: tester
tags: [alpha, beta]
args:
  - name: topic
    description: the research topic
    required: true
  - name: depth
    default: standard
steps:
  - id: collect
    title: 收集
    role: 收集员
    prompt: 研究 {{args.topic}},深度 {{args.depth}}
  - id: report
    prompt: 基于 {{steps.collect.output}} 成稿
---

正文补充说明。
`;

describe("parseSopContent", () => {
	it("parses frontmatter, steps, args and body", () => {
		const { sop, errors } = parseSopContent(VALID_SOP, "demo", "/tmp/demo/SOP.md");
		expect(errors).toEqual([]);
		expect(sop).not.toBeNull();
		expect(sop!.name).toBe("demo");
		expect(sop!.version).toBe("1.2.0");
		expect(sop!.tags).toEqual(["alpha", "beta"]);
		expect(sop!.args).toHaveLength(2);
		expect(sop!.args[0]).toMatchObject({ name: "topic", required: true });
		expect(sop!.steps).toHaveLength(2);
		expect(sop!.steps[0]).toMatchObject({ id: "collect", role: "收集员" });
		expect(sop!.body).toContain("正文补充说明");
	});

	it("requires a non-empty description", () => {
		const { sop, errors } = parseSopContent("---\nname: x\nsteps:\n  - id: a\n    prompt: p\n---\n", "x", "/x/SOP.md");
		expect(sop).toBeNull();
		expect(errors.some((e) => e.includes("description"))).toBe(true);
	});

	it("rejects missing / empty steps", () => {
		const { sop, errors } = parseSopContent("---\ndescription: d\n---\n", "x", "/x/SOP.md");
		expect(sop).toBeNull();
		expect(errors[0]).toContain("steps");
	});

	it("rejects duplicate step ids and prompts without content", () => {
		const raw = [
			"---",
			"description: d",
			"steps:",
			"  - id: a",
			"    prompt: p1",
			"  - id: a",
			"    prompt: p2",
			"  - id: b",
			"    prompt: ''",
			"---",
			"",
	 ].join("\n");
		const { sop, errors } = parseSopContent(raw, "x", "/x/SOP.md");
		expect(sop).not.toBeNull(); // b 被剔除,a 保留
		expect(errors.some((e) => e.includes("duplicate step id"))).toBe(true);
		expect(errors.some((e) => e.includes("missing its `prompt`"))).toBe(true);
	});
});

describe("loadSopsFromDir", () => {
	it("lists valid SOPs sorted by slug and skips broken ones with diagnostics", () => {
		const root = makeTempDir();
		mkdirSync(join(root, "zeta"), { recursive: true });
		writeFileSync(join(root, "zeta", "SOP.md"), VALID_SOP);
		mkdirSync(join(root, "alpha"), { recursive: true });
		writeFileSync(join(root, "alpha", "SOP.md"), VALID_SOP.replace("name: demo", "name: alpha-demo"));
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "SOP.md"), "---\nname: broken\n---\nno steps");

		const { sops, diagnostics } = loadSopsFromDir(root);
		expect(sops.map((s) => s.slug)).toEqual(["alpha", "zeta"]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("broken");
	});

	it("treats a missing directory as empty", () => {
		const { sops, diagnostics } = loadSopsFromDir(join(makeTempDir(), "nope"));
		expect(sops).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});

describe("findInstalledSop", () => {
	it("resolves by slug and by name (case-insensitive)", () => {
		const agentDir = makeTempDir("zharness-sop-agent-");
		mkdirSync(join(agentDir, "sops", "demo"), { recursive: true });
		writeFileSync(join(agentDir, "sops", "demo", "SOP.md"), VALID_SOP);

		expect(findInstalledSop("demo", agentDir)?.slug).toBe("demo");
		expect(findInstalledSop("DEMO", agentDir)?.slug).toBe("demo");
		expect(findInstalledSop("missing", agentDir)).toBeNull();
	});
});

describe("renderTemplate", () => {
	const argDefs = [
		{ name: "topic", required: true },
		{ name: "depth", default: "standard" },
	];

	it("substitutes provided values and defaults", () => {
		const { text, missing } = renderTemplate("{{args.topic}} / {{args.depth}}", { topic: "AI" }, argDefs);
		expect(text).toBe("AI / standard");
		expect(missing).toEqual([]);
	});

	it("keeps the placeholder for unresolved args and reports them", () => {
		const { text, missing } = renderTemplate("{{args.topic}}", {}, argDefs);
		expect(text).toBe("{{args.topic}}");
		expect(missing).toEqual(["topic"]);
	});

	it("leaves step placeholders untouched", () => {
		const { text } = renderTemplate("{{steps.collect.output}}", {}, []);
		expect(text).toBe("{{steps.collect.output}}");
	});
});

describe("parseRunArgs", () => {
	it("parses name plus key=value pairs with quoted values", () => {
		const { name, args } = parseRunArgs('deep-research topic="large language models" depth=deep');
		expect(name).toBe("deep-research");
		expect(args).toEqual({ topic: "large language models", depth: "deep" });
	});

	it("handles name only and ignores tokens without =", () => {
		const { name, args } = parseRunArgs("weekly-report stray");
		expect(name).toBe("weekly-report");
		expect(args).toEqual({});
	});
});

describe("renderSopWorkflowPrompt", () => {
	it("renders header, run args, numbered steps with roles, and the body", () => {
		const { sop } = parseSopContent(VALID_SOP, "demo", "/tmp/demo/SOP.md");
		const prompt = renderSopWorkflowPrompt(sop!, { topic: "量子计算" });
		expect(prompt).toContain("【SOP 工作流】demo");
		expect(prompt).toContain("步骤 1/2");
		expect(prompt).toContain("(角色:收集员)");
		expect(prompt).toContain("topic: 量子计算");
		expect(prompt).toContain("depth: standard");
		expect(prompt).toContain("{{steps.collect.output}}");
		expect(prompt).toContain("SOP 补充说明");
		expect(prompt).toContain("正文补充说明");
	});

	it("marks missing required args so the model asks the user first", () => {
		const { sop } = parseSopContent(VALID_SOP, "demo", "/tmp/demo/SOP.md");
		const prompt = renderSopWorkflowPrompt(sop!, {});
		expect(prompt).toContain("topic: （未提供 —— 开始前先向用户询问）");
	});
});

const DYNAMIC_SCRIPT = [
	"interface Plan {",
	"  /** 一句话结论 */",
	"  conclusion: string;",
	"}",
	'phase("执行");',
	'const plan = await agent("规划员").ask<Plan>("拆解任务", { of: "Plan" });',
	"return plan;",
].join("\n");

function dynamicFrontmatter(extra = ""): string {
	return `---\nname: dyn\ndescription: dynamic demo\nkind: dynamic\nconcurrency: 3${extra}\nargs:\n  - name: task\n    required: true\n---\n\n正文。\n`;
}

describe("parseSopContent (dynamic)", () => {
	it("parses a dynamic SOP: steps optional, script source attached", () => {
		const { sop, errors } = parseSopContent(dynamicFrontmatter(), "dyn", "/dyn/SOP.md", {
			scriptSource: DYNAMIC_SCRIPT,
			scriptPath: "/dyn/workflow.ts",
		});
		expect(errors).toEqual([]);
		expect(sop).not.toBeNull();
		expect(sop!.kind).toBe("dynamic");
		expect(sop!.steps).toEqual([]);
		expect(sop!.scriptSource).toContain("规划员");
		expect(sop!.scriptPath).toBe("/dyn/workflow.ts");
		expect(sop!.concurrency).toBe(3);
	});

	it("implies dynamic from a script when kind is not declared", () => {
		const raw = "---\nname: dyn\ndescription: d\n---\n";
		const { sop } = parseSopContent(raw, "dyn", "/dyn/SOP.md", { scriptSource: "return 1;" });
		expect(sop?.kind).toBe("dynamic");
	});

	it("rejects kind: dynamic without a script", () => {
		const { sop, errors } = parseSopContent(dynamicFrontmatter(), "dyn", "/dyn/SOP.md");
		expect(sop).toBeNull();
		expect(errors.some((e) => e.includes("workflow.ts"))).toBe(true);
	});

	it("rejects a script alongside an explicit kind: static", () => {
		const raw = `---\nname: s\ndescription: d\nkind: static\nsteps:\n  - id: a\n    prompt: p\n---\n`;
		const { sop, errors } = parseSopContent(raw, "s", "/s/SOP.md", { scriptSource: "return 1;" });
		expect(sop).toBeNull();
		expect(errors.some((e) => e.includes("kind: dynamic"))).toBe(true);
	});

	it("rejects unknown kind values", () => {
		const raw = "---\ndescription: d\nkind: hybrid\n---\n";
		const { sop, errors } = parseSopContent(raw, "x", "/x/SOP.md");
		expect(sop).toBeNull();
		expect(errors.some((e) => e.includes('"static" or "dynamic"'))).toBe(true);
	});
});

describe("loadSopFile (dynamic sidecar)", () => {
	it("reads workflow.ts next to SOP.md and loads a dynamic SOP", () => {
		const root = makeTempDir();
		const dir = join(root, "dyn");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SOP.md"), dynamicFrontmatter());
		writeFileSync(join(dir, "workflow.ts"), DYNAMIC_SCRIPT);
		const { sop, errors } = loadSopFile(join(dir, "SOP.md"));
		expect(errors).toEqual([]);
		expect(sop?.kind).toBe("dynamic");
		expect(sop?.scriptSource).toContain("interface Plan");
		expect(sop?.scriptPath).toBe(join(dir, "workflow.ts"));
	});

	it("reports an error when frontmatter declares dynamic but the script is missing", () => {
		const root = makeTempDir();
		const dir = join(root, "dyn");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SOP.md"), dynamicFrontmatter());
		const { sop, errors } = loadSopFile(join(dir, "SOP.md"));
		expect(sop).toBeNull();
		expect(errors.some((e) => e.includes("requires"))).toBe(true);
	});

	it("loads a static SOP unchanged when no sidecar exists", () => {
		const root = makeTempDir();
		const dir = join(root, "demo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SOP.md"), VALID_SOP);
		const { sop, errors } = loadSopFile(join(dir, "SOP.md"));
		expect(errors).toEqual([]);
		expect(sop?.kind).toBe("static");
		expect(sop?.scriptSource).toBeUndefined();
	});
});
