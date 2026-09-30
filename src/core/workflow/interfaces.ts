/**
 * 从工作流脚本源码中提取 `interface X { ... }` 声明。
 *
 * 动态工作流没有独立的类型检查器(脚本经 jiti 转译即执行,不做完整
 * typecheck),typed ask 的 JSON 契约靠把接口源码(含 JSDoc 字段说明)
 * 原文交给子代理来实现:引擎在 ask(..., { of: "Plan" }) 时查这里提取的
 * 接口文本,追加到指令末尾。
 *
 * 提取器是刻意轻量的:去注释 → 找 `interface Name {` 起点 → 括号配平
 * (跳过字符串/模板字面量)。不解析语义;不支持 declare/module 增强。
 */

/** 去掉 // 行注释、块注释与正则字面量之外无需处理的内容(保守实现)。 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	const n = source.length;
	let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
	while (i < n) {
		const ch = source[i];
		const next = i + 1 < n ? source[i + 1] : "";
		if (mode === "code") {
			if (ch === "/" && next === "/") {
				mode = "line";
				i += 2;
				continue;
			}
			if (ch === "/" && next === "*") {
				mode = "block";
				i += 2;
				continue;
			}
			if (ch === "'") {
				mode = "single";
				out += ch;
				i++;
				continue;
			}
			if (ch === '"') {
				mode = "double";
				out += ch;
				i++;
				continue;
			}
			if (ch === "`") {
				mode = "template";
				out += ch;
				i++;
				continue;
			}
			out += ch;
			i++;
			continue;
		}
		if (mode === "line") {
			if (ch === "\n") {
				mode = "code";
				out += "\n";
			}
			i++;
			continue;
		}
		if (mode === "block") {
			if (ch === "*" && next === "/") {
				mode = "code";
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		// 字符串/模板字面量:保留原文(模板字面量里的 ${...} 简化按字面处理)。
		out += ch;
		if (ch === "\\" && i + 1 < n) {
			out += source[i + 1];
			i += 2;
			continue;
		}
		if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"') || (mode === "template" && ch === "`")) {
			mode = "code";
		}
		i++;
	}
	return out;
}

const INTERFACE_START = /\binterface\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[A-Za-z_$][\w$.\s,]*)?\{/g;

/**
 * 提取脚本中全部 interface 声明,返回 name → 声明原文
 * (含 interface 关键字与 JSDoc 之外的正文字段注释)。
 */
export function extractInterfaces(source: string): Map<string, string> {
	const interfaces = new Map<string, string>();
	const cleaned = stripComments(source);
	INTERFACE_START.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INTERFACE_START.exec(cleaned)) !== null) {
		const name = match[1];
		if (interfaces.has(name)) continue;
		// 从 `{` 起括号配平,跳过字符串字面量内的花括号。
		const openBrace = cleaned.indexOf("{", match.index);
		let depth = 0;
		let i = openBrace;
		let inString: "'" | '"' | "`" | null = null;
		for (; i < cleaned.length; i++) {
			const ch = cleaned[i];
			if (inString) {
				if (ch === "\\") {
					i++;
					continue;
				}
				if (ch === inString) inString = null;
				continue;
			}
			if (ch === "'" || ch === '"' || ch === "`") {
				inString = ch;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) continue; // 未闭合,交给转译器报错
		const body = cleaned.slice(match.index, i + 1).trim();
		interfaces.set(name, body);
	}
	return interfaces;
}

/**
 * 从子代理的最终回复中提取 JSON 结果:
 * 优先取最后一个 ```json 围栏块,其次整体就是 JSON 的情况;
 * 都不是则返回 undefined(调用方按文本结果处理或报契约错误)。
 */
export function extractJsonResult(text: string): unknown {
	const fenced = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
	let last: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = fenced.exec(text)) !== null) {
		last = m[1];
	}
	const candidates: string[] = [];
	if (last !== undefined) candidates.push(last);
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// 试下一个候选
		}
	}
	return undefined;
}
