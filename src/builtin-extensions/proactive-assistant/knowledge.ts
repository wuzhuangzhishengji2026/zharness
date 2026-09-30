/**
 * proactive-assistant 知识沉淀 —— 把「做得好的一轮」写进主 agent 长期记忆库。
 *
 * 目标位置与 get_persona / PersonaCard 同一体系：
 *   <mainDir>/memory/knowledge-<date>-<slug>.md   （正文，含 frontmatter）
 *   <mainDir>/memory/_index.md                     （追加索引行）
 *
 * 写入 _index.md 后，下一次会话边界的系统提示词（Long-Term Memory 节）会
 * 自然带上这条索引 —— 沉淀即刻对 agent 可见。
 *
 * 草稿生成是确定性的：从会话投影取「用户目标（首条用户消息）+ 过程统计 +
 * 最终结论（最后一条 assistant 文本）」，由用户在 GUI 编辑确认后落盘。
 * 沉淀永远是显式动作：这里只提供草稿与保存，不代替用户决定。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMainDir, getMainMemoryDir } from "../../config.js";

/** 一份知识草稿（GUI 可编辑后回传保存）。 */
export interface KnowledgeDraft {
	title: string;
	content: string;
	tags: string[];
}

/** 草稿生成的输入（由 RPC 层从会话投影收集，保持本模块无 facade 依赖）。 */
export interface KnowledgeDraftInput {
	/** 本会话首条用户消息（用户目标）。 */
	firstUserMessage?: string;
	/** 最后一条 assistant 文本（最终结论）。 */
	lastAssistantText?: string;
	/** 会话统计。 */
	toolCalls: number;
	toolFailures: number;
	userTurns: number;
	sessionId: string;
}

/** 保存结果。 */
export interface KnowledgeSaveResult {
	/** 落盘的知识文件绝对路径。 */
	path: string;
	/** 是否同步更新了 _index.md。 */
	indexUpdated: boolean;
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/** 截断到单行、限定长度，用于标题/摘要。 */
function toSingleLine(text: string | undefined, max: number): string {
	const line = (text ?? "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 从最后一条 assistant 文本取结论段（优先最后一个非空段落）。 */
function conclusionParagraph(text: string | undefined): string {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return "";
	const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	return last.length > 400 ? `${last.slice(0, 400)}…` : last;
}

/** 生成知识草稿（预填内容，用户可改）。 */
export function buildKnowledgeDraft(input: KnowledgeDraftInput): KnowledgeDraft {
	const goal = toSingleLine(input.firstUserMessage, 80);
	const conclusion = conclusionParagraph(input.lastAssistantText);
	const title = goal ? `经验：${goal}` : "经验：一次顺利的任务";

	const lines: string[] = [];
	lines.push("## 任务");
	lines.push("");
	lines.push(input.firstUserMessage?.trim() || "（本会话首条用户消息未记录）");
	lines.push("");
	lines.push("## 做法与结论");
	lines.push("");
	if (conclusion) {
		lines.push(conclusion);
	} else {
		lines.push("（待补充：这次任务的关键做法、踩过的点、下次可直接复用的步骤。）");
	}
	lines.push("");
	lines.push("## 过程");
	lines.push("");
	lines.push(
		`用户轮数 ${input.userTurns} · 工具调用 ${input.toolCalls} 次 · 失败 ${input.toolFailures} 次（全程零失败触发沉淀）。`,
	);

	return {
		title,
		content: lines.join("\n"),
		tags: ["knowledge", "proactive-assistant"],
	};
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

/** 文件名安全片段：仅保留 ascii 字母数字与连字符，空则退回随机串。 */
function toSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return slug.length > 0 ? slug : randomUUID().slice(0, 6);
}

function toIsoDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * 保存一条知识到主 agent 记忆库：写 `knowledge-<date>-<slug>.md` 并向
 * `_index.md` 追加索引行（文件缺失时创建最小索引）。
 */
export function saveKnowledge(
	draft: KnowledgeDraft,
	options?: { mainDir?: string; memoryDir?: string; now?: Date },
): KnowledgeSaveResult {
	const now = options?.now ?? new Date();
	const resolvedMainDir = options?.mainDir ?? getMainDir();
	const memoryDir = options?.memoryDir ?? getMainMemoryDir(resolvedMainDir);

	mkdirSync(memoryDir, { recursive: true });

	const title = draft.title.trim() || `经验 ${toIsoDate(now)}`;
	const fileName = `knowledge-${toIsoDate(now).replace(/-/g, "")}-${toSlug(title)}.md`;
	const filePath = join(memoryDir, fileName);

	const frontmatter = [
		"---",
		`date: ${toIsoDate(now)}`,
		"source: proactive-assistant",
		`tags: [${draft.tags.map((t) => t.replace(/[,\[\]]/g, "").trim()).filter(Boolean).join(", ")}]`,
		"---",
		"",
	].join("\n");

	const body = `# ${title}\n\n${draft.content.trim()}\n`;
	const fileContent = `${frontmatter}${body}`;

	// 原子写入：先临时文件再 rename，半写状态不会污染记忆库。
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, fileContent, "utf-8");
	renameSync(tmp, filePath);

	// 追加索引行（幂等：同名行已存在时不重复追加）。
	const indexPath = join(memoryDir, "_index.md");
	const indexLine = `- ${fileName} — ${toSingleLine(title, 60)}（proactive-assistant 沉淀）`;
	let indexUpdated = false;
	if (!existsSync(indexPath)) {
		writeFileSync(indexPath, `# Memory Index\n\n${indexLine}\n`, "utf-8");
		indexUpdated = true;
	} else {
		const existing = readFileSync(indexPath, "utf-8");
		if (!existing.includes(fileName)) {
			writeFileSync(indexPath, `${existing.trimEnd()}\n${indexLine}\n`, "utf-8");
			indexUpdated = true;
		}
	}

	return { path: filePath, indexUpdated };
}
