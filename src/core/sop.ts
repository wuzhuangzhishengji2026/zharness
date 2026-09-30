/**
 * SOP(标准操作流程)工作流模板:解析、加载与运行期渲染。
 *
 * SOP 有两种形态,共用同一市场与安装管线:
 *
 * - static(默认):声明式步骤表。SOP.md 由 YAML frontmatter
 *   (name/description/version/author/tags/args/steps)加 Markdown 正文组成。
 *   steps 是有序步骤表,每步含 id/title/role/prompt,parallel 组内的步骤
 *   相互独立、可并行处理;prompt 内可引用 `{{args.<name>}}`(安装侧运行时
 *   替换)与 `{{steps.<id>.output}}`(执行侧由模型按上文解析)。运行入口
 *   renderSopWorkflowPrompt 把定义渲染成编排提示词交给当前会话的模型。
 *
 * - dynamic(动态工作流):对齐 ZCode CreateWorkflow 的脚本编排模型。
 *   frontmatter 声明 `kind: dynamic`,同目录的 workflow.ts 是一份
 *   TypeScript 脚本,以 facade(agent/ask/phase/log/report/world/files/
 *   git/artifact/args)编排多个独立子代理会话,支持循环、分支与扇出。
 *   运行入口见 core/workflow(engine)。args 声明与 static 相同,
 *   启动前做必填/默认值校验。
 *
 * 两者都安装在:
 *
 *   <agentDir>/sops/<slug>/SOP.md (dynamic 另含 workflow.ts)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/** SOP 文件名(目录内唯一入口,同 SKILL.md 的约定)。 */
export const SOP_FILENAME = "SOP.md";

/** 动态工作流 SOP 的脚本文件名(与 SOP.md 同目录)。 */
export const SOP_SCRIPT_FILENAME = "workflow.ts";

/** SOP 形态:声明式步骤表(static)或脚本编排的动态工作流(dynamic)。 */
export type SopKind = "static" | "dynamic";

/** SOP 名称约束(与技能一致:小写字母/数字/连字符,兼容中文场景下的目录名)。 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** frontmatter 中声明的运行参数。 */
export interface SopArgDef {
	name: string;
	description?: string;
	required?: boolean;
	default?: string;
}

/** frontmatter 中声明的一个工作流步骤。 */
export interface SopStepDef {
	id: string;
	title?: string;
	/** 该步骤的执行角色(写入提示词,引导模型切换视角)。 */
	role?: string;
	/** 步骤指令;支持 {{args.x}} / {{steps.<id>.output}} 占位符。 */
	prompt: string;
	/** 与相邻的 parallel 步骤构成并行组(相互独立,可同轮/子代理处理)。 */
	parallel?: boolean;
}

export interface SopFrontmatter {
	name?: string;
	description?: string;
	version?: string;
	author?: string;
	tags?: string[];
	/** static(默认)| dynamic —— dynamic 需要 workflow.ts 脚本,steps 可省略。 */
	kind?: string;
	/** dynamic:SOP.md 同目录的脚本文件名,默认 workflow.ts。 */
	script?: string;
	/** dynamic:子代理并发上限(默认由引擎决定)。 */
	concurrency?: number;
	args?: SopArgDef[];
	steps?: SopStepDef[];
	[key: string]: unknown;
}

/** 解析后的完整 SOP 定义。 */
export interface Sop {
	slug: string;
	name: string;
	description: string;
	/** static = 声明式步骤表;dynamic = workflow.ts 脚本编排。 */
	kind: SopKind;
	version?: string;
	author?: string;
	tags: string[];
	args: SopArgDef[];
	/** static 的步骤表;dynamic 为空数组。 */
	steps: SopStepDef[];
	/** dynamic:脚本内容(workflow.ts 原文)。static 为 undefined。 */
	scriptSource?: string;
	/** dynamic:脚本文件绝对路径。static 为 undefined。 */
	scriptPath?: string;
	/** dynamic:子代理并发上限。 */
	concurrency?: number;
	/** Markdown 正文(frontmatter 之外的补充说明)。 */
	body: string;
	filePath: string;
	baseDir: string;
}

export interface ParseSopResult {
	sop: Sop | null;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验并归一化 frontmatter 中的 args 定义。 */
function normalizeArgs(raw: unknown): { args: SopArgDef[]; errors: string[] } {
	const errors: string[] = [];
	if (raw === undefined || raw === null) return { args: [], errors };
	if (!Array.isArray(raw)) {
		return { args: [], errors: ["`args` must be a list of {name, description, required, default}"] };
	}
	const args: SopArgDef[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) {
			errors.push("`args` entry missing a non-empty `name`");
			continue;
		}
		args.push({
			name: item.name.trim(),
			description: typeof item.description === "string" ? item.description : undefined,
			required: item.required === true,
			default: typeof item.default === "string" ? item.default : undefined,
		});
	}
	return { args, errors };
}

/** 校验并归一化 frontmatter 中的 steps 定义。 */
function normalizeSteps(raw: unknown): { steps: SopStepDef[]; errors: string[] } {
	const errors: string[] = [];
	if (!Array.isArray(raw) || raw.length === 0) {
		return { steps: [], errors: ["`steps` must be a non-empty list of {id, prompt}"] };
	}
	const steps: SopStepDef[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!isRecord(item)) {
			errors.push("`steps` entry must be a mapping");
			continue;
		}
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
			errors.push(`step id must match [A-Za-z0-9_-] (got "${id || "(missing)"}")`);
			continue;
		}
		if (seen.has(id)) {
			errors.push(`duplicate step id "${id}"`);
			continue;
		}
		seen.add(id);
		const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
		if (!prompt) {
			errors.push(`step "${id}" is missing its \`prompt\``);
			continue;
		}
		steps.push({
			id,
			title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined,
			role: typeof item.role === "string" && item.role.trim() ? item.role.trim() : undefined,
			prompt,
			parallel: item.parallel === true,
		});
	}
	return { steps, errors };
}

/**
 * 解析一份 SOP.md 内容。name/description 缺失、static 缺 steps、dynamic
 * 缺脚本时返回 sop=null 与错误列表;轻度问题(tags 非列表等)降级处理不致命。
 *
 * dynamic 判定:frontmatter `kind: dynamic`,或同目录脚本内容已读入
 * (options.scriptSource)且 kind 未显式声明为 static。dynamic 的 steps
 * 可省略(脚本才是编排本体)。
 */
export function parseSopContent(
	raw: string,
	slug: string,
	filePath: string,
	options?: { scriptSource?: string; scriptPath?: string },
): ParseSopResult {
	const errors: string[] = [];
	const { frontmatter, body } = parseFrontmatter<SopFrontmatter>(raw);

	const name = (frontmatter.name ?? slug).trim();
	const description = (frontmatter.description ?? "").trim();
	if (!description) {
		errors.push("`description` is required");
	}

	const declaredKind =
		frontmatter.kind === undefined || frontmatter.kind === null ? undefined : String(frontmatter.kind).trim();
	if (declaredKind !== undefined && declaredKind !== "" && declaredKind !== "static" && declaredKind !== "dynamic") {
		errors.push(`\`kind\` must be "static" or "dynamic" (got "${declaredKind}")`);
	}
	const scriptSource = options?.scriptSource?.trim() ? options.scriptSource : undefined;
	let kind: SopKind;
	if (declaredKind === "static") {
		kind = "static";
		if (scriptSource !== undefined) {
			errors.push("script file is only valid with `kind: dynamic`");
		}
	} else {
		kind = declaredKind === "dynamic" || scriptSource !== undefined ? "dynamic" : "static";
	}
	if (kind === "dynamic" && scriptSource === undefined) {
		errors.push(`dynamic SOP requires a ${options?.scriptPath ?? SOP_SCRIPT_FILENAME} script next to SOP.md`);
	}

	const tags = Array.isArray(frontmatter.tags)
		? frontmatter.tags.filter((t): t is string => typeof t === "string")
		: [];

	const { args, errors: argErrors } = normalizeArgs(frontmatter.args);
	errors.push(...argErrors);
	// dynamic 的编排本体是脚本:steps 声明被忽略(不校验、不加载)。
	const { steps, errors: stepErrors } =
		kind === "dynamic" ? { steps: [], errors: [] } : normalizeSteps(frontmatter.steps);
	errors.push(...stepErrors);
	if (kind === "static" && steps.length === 0 && stepErrors.length === 0) {
		errors.push("`steps` must be a non-empty list of {id, prompt} (or set `kind: dynamic` with a script)");
	}

	const concurrency =
		typeof frontmatter.concurrency === "number" && Number.isInteger(frontmatter.concurrency) && frontmatter.concurrency > 0
			? frontmatter.concurrency
			: undefined;

	// 致命错误:description 缺失、static 无可用步骤、static 带脚本(会被静默
	// 忽略,拒绝更安全)、dynamic 无脚本、kind 非法。步骤级问题(重复 id、
	// 缺 prompt)降级为告警 —— 剔除该步、其余照常加载,与 skills.ts
	// 「带 warning 加载」的行为一致。
	const fatal =
		!description ||
		(kind === "static" && (steps.length === 0 || scriptSource !== undefined)) ||
		(kind === "dynamic" && scriptSource === undefined);
	if (fatal) {
		return { sop: null, errors };
	}

	return {
		sop: {
			slug,
			name,
			description,
			kind,
			version: typeof frontmatter.version === "string" ? frontmatter.version : undefined,
			author: typeof frontmatter.author === "string" ? frontmatter.author : undefined,
			tags,
			args,
			steps,
			scriptSource: kind === "dynamic" ? scriptSource : undefined,
			scriptPath: kind === "dynamic" ? options?.scriptPath : undefined,
			concurrency,
			body: body.trim(),
			filePath,
			baseDir: filePath.substring(0, filePath.length - SOP_FILENAME.length - 1),
		},
		errors,
	};
}

/** 从文件加载单个 SOP(读文件 + 解析;dynamic SOP 同时读同目录脚本)。 */
export function loadSopFile(filePath: string, slug?: string): ParseSopResult {
	const effectiveSlug = slug ?? basename(dirname(filePath));
	try {
		const raw = readFileSync(filePath, "utf-8");
		const scriptPath = join(dirname(filePath), SOP_SCRIPT_FILENAME);
		let scriptSource: string | undefined;
		let scriptError: string | undefined;
		if (existsSync(scriptPath)) {
			try {
				scriptSource = readFileSync(scriptPath, "utf-8");
			} catch (error) {
				scriptError = error instanceof Error ? error.message : "failed to read workflow script";
			}
		}
		const result = parseSopContent(raw, effectiveSlug, filePath, { scriptSource, scriptPath });
		if (scriptError) result.errors.push(scriptError);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read SOP file";
		return { sop: null, errors: [message] };
	}
}

export interface LoadSopsResult {
	sops: Sop[];
	diagnostics: string[];
}

/**
 * 扫描目录下的 SOP(<dir>/<slug>/SOP.md),返回按 slug 排序的列表。
 * 目录不存在视为空(非错误)。跳过无法解析的条目并记录诊断。
 */
export function loadSopsFromDir(dir: string): LoadSopsResult {
	const sops: Sop[] = [];
	const diagnostics: string[] = [];
	if (!existsSync(dir)) {
		return { sops, diagnostics };
	}
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read SOP dir";
		diagnostics.push(`${dir}: ${message}`);
		return { sops, diagnostics };
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = statSync(join(dir, entry.name)).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDir) continue;
		const filePath = join(dir, entry.name, SOP_FILENAME);
		if (!existsSync(filePath)) continue;
		const result = loadSopFile(filePath, entry.name);
		if (result.errors.length > 0) {
			diagnostics.push(`${filePath}: ${result.errors.join("; ")}`);
		}
		if (result.sop) {
			sops.push(result.sop);
		}
	}
	sops.sort((a, b) => a.slug.localeCompare(b.slug));
	return { sops, diagnostics };
}

/** 已安装 SOP 的根目录:<agentDir>/sops。 */
export function getSopsRoot(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "sops");
}

/** 加载已安装的全部 SOP。 */
export function loadInstalledSops(agentDir?: string): LoadSopsResult {
	return loadSopsFromDir(getSopsRoot(agentDir));
}

/** 按 slug(或大小写不敏感的 name)查找已安装的 SOP。 */
export function findInstalledSop(query: string, agentDir?: string): Sop | null {
	const { sops } = loadInstalledSops(agentDir);
	const q = query.trim().toLowerCase();
	return (
		sops.find((s) => s.slug.toLowerCase() === q) ??
		sops.find((s) => s.name.toLowerCase() === q) ??
		null
	);
}

/**
 * `{{args.<name>}}` 占位符替换:已提供或 default 的参数原样替换,
 * 未提供的必填参数保留占位符并收集提示,让模型显式向用户询问。
 */
export function renderTemplate(
	template: string,
	args: Record<string, string>,
	argDefs: SopArgDef[],
): { text: string; missing: string[] } {
	const missing: string[] = [];
	const defaults = new Map(argDefs.map((d) => [d.name, d.default]));
	const text = template.replace(/\{\{\s*args\.([A-Za-z0-9_-]+)\s*\}\}/g, (_m, name: string) => {
		if (Object.prototype.hasOwnProperty.call(args, name)) return args[name];
		const def = defaults.get(name);
		if (def !== undefined) return def;
		missing.push(name);
		return `{{args.${name}}}`;
	});
	return { text, missing };
}

/** 解析 `/sop run <slug> k1=v1 k2="带空格 的值"` 风格的参数串。 */
export function parseRunArgs(input: string): { name: string; args: Record<string, string> } {
	const trimmed = input.trim();
	if (!trimmed) {
		return { name: "", args: {} };
	}
	const spaceIndex = trimmed.search(/\s/);
	const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).trim();
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);
	const args: Record<string, string> = {};
	const kv = /([A-Za-z0-9_-]+)=("(?:[^"]*)"|'(?:[^']*)'|[^\s"']+)/g;
	let m: RegExpExecArray | null;
	while ((m = kv.exec(rest)) !== null) {
		const raw = m[2];
		const quoted =
			(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) ||
			(raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'"));
		args[m[1]] = quoted ? raw.slice(1, -1) : raw;
	}
	return { name, args };
}

/**
 * 把 SOP 定义渲染成发给模型的编排提示词。
 *
 * 结构对齐 ZCode 工作流的运行契约:明确步骤总数与推进规则、
 * 每步的角色与指令、并行组的处理方式、{{steps.<id>.output}}
 * 占位符的含义,以及最终交付要求。missing 参数会引导模型先询问用户。
 */
export function renderSopWorkflowPrompt(sop: Sop, args: Record<string, string> = {}): string {
	const lines: string[] = [];
	lines.push(`【SOP 工作流】${sop.name} — ${sop.description}`);
	const meta: string[] = [];
	if (sop.version) meta.push(`版本 ${sop.version}`);
	if (sop.author) meta.push(`作者 ${sop.author}`);
	if (meta.length > 0) lines.push(meta.join(" · "));
	lines.push("");

	lines.push("请严格按照以下步骤执行该工作流:");
	lines.push("- 按编号顺序推进;每一步完成后先给出该步的结果小结,再进入下一步。");
	lines.push("- 标注[并行组]的相邻步骤相互独立,可合并到同一轮处理,或在可用时交给子代理并行执行。");
	lines.push("- 指令中的 `{{steps.<id>.output}}` 指代该步骤的结果小结,执行时用上文实际内容代替。");
	lines.push("- 指令中残留的 `{{args.<name>}}` 表示该参数未提供:按「运行参数」一节的说明处理(必填先询问用户,可选按默认)。");
	lines.push("- 全部步骤完成后,输出最终交付物(最后一步通常定义了交付格式)。");
	lines.push("");

	if (sop.args.length > 0) {
		lines.push("## 运行参数");
		for (const def of sop.args) {
			const value = Object.prototype.hasOwnProperty.call(args, def.name)
				? args[def.name]
				: def.default !== undefined
					? def.default
					: def.required
						? "（未提供 —— 开始前先向用户询问）"
						: "（未提供,按指令默认处理）";
			lines.push(`- ${def.name}: ${value}${def.description ? ` — ${def.description}` : ""}`);
		}
		lines.push("");
	}

	const total = sop.steps.length;
	sop.steps.forEach((step, index) => {
		const parallelMark = step.parallel ? " [并行组]" : "";
		const role = step.role ? `(角色:${step.role})` : "";
		lines.push(`## 步骤 ${index + 1}/${total} — ${step.title ?? step.id} ${parallelMark}${role}`);
		lines.push(renderTemplate(step.prompt, args, sop.args).text);
		lines.push("");
	});

	if (sop.body) {
		lines.push("---");
		lines.push("");
		lines.push("## SOP 补充说明");
		lines.push(sop.body);
		lines.push("");
	}

	return lines.join("\n").trim() + "\n";
}

/** Slug 合法性(安装/卸载入口共用)。 */
export function isValidSopSlug(slug: string): boolean {
	return SLUG_RE.test(slug.trim());
}
