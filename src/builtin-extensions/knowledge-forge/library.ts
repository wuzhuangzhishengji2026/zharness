/**
 * knowledge-forge 沉淀库。
 *
 * 目录结构（root 由 destination 决定）：
 *   <root>/knowledge/<category>/<yyyymmdd>-<slug>.md   知识条目
 *   <root>/skills/<category>/<yyyymmdd>-<slug>.md     技能条目
 *   <root>/INDEX.md                                   人类可读索引（按类目分组）
 *
 * 条目带 frontmatter（kind/category/title/date/tags/source_sessions），
 * 去重按「同 kind+category 下已存在同名 title」判定，重复保存返回
 * duplicate 而不覆盖——夜间任务重复触发不会写坏库。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMainDir } from "../../config.js";
import type { LibraryDestination } from "./config.js";

export type EntryKind = "knowledge" | "skill";

/** 一条待沉淀的知识/技能。 */
export interface LibraryEntry {
	kind: EntryKind;
	/** 类目（如 "环境与构建"、"调试技巧"、"工作流"）。 */
	category: string;
	title: string;
	content: string;
	tags?: string[];
	/** 来源会话 id（溯源用）。 */
	sourceSessions?: string[];
}

export type SaveEntryResult =
	| { status: "saved"; path: string }
	| { status: "duplicate"; path: string }
	| { status: "invalid"; error: string };

export interface ResolveRootOptions {
	destination: LibraryDestination;
	/** 全局库根（默认 <mainDir>/knowledge-forge/library）。 */
	mainDir?: string;
	/** 项目目录（destination === "project" 时必填）。 */
	projectDir?: string;
}

/** 解析沉淀库根目录。 */
export function resolveLibraryRoot(options: ResolveRootOptions): string {
	if (options.destination === "project") {
		if (!options.projectDir) throw new Error("destination=project 需要 projectDir");
		return join(options.projectDir, ".zharness", "knowledge-forge", "library");
	}
	return join(options.mainDir ?? getMainDir(), "knowledge-forge", "library");
}

/** 文件名安全片段：ascii 字母数字与连字符，空则退回随机串。 */
function toSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug.length > 0 ? slug : randomUUID().slice(0, 6);
}

/** 类目目录名安全化：去路径分隔符与空白，空则归为 misc。 */
function categoryDir(category: string): string {
	const cleaned = category.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	return cleaned.length > 0 ? cleaned : "misc";
}

function entryFileName(title: string, now: Date): string {
	const date = now.toISOString().slice(0, 10).replace(/-/g, "");
	return `${date}-${toSlug(title)}.md`;
}

function sanitizeList(values: string[] | undefined): string[] {
	return (values ?? []).map((v) => String(v).replace(/[,\[\]]/g, "").trim()).filter(Boolean).slice(0, 8);
}

/** kind 对应的目录名（skills 用复数，与人类阅读习惯一致）。 */
function kindDirName(kind: EntryKind): string {
	return kind === "knowledge" ? "knowledge" : "skills";
}

/** 保存一条沉淀。同名条目（同 kind+category）已存在时返回 duplicate。 */
export function saveEntry(
	entry: LibraryEntry,
	root: string,
	options?: { now?: Date },
): SaveEntryResult {
	const title = entry.title.trim();
	if (!title) return { status: "invalid", error: "title 不能为空" };
	const content = entry.content.trim();
	if (!content) return { status: "invalid", error: "content 不能为空" };

	const now = options?.now ?? new Date();
	const kindDir = join(root, kindDirName(entry.kind), categoryDir(entry.category));
	mkdirSync(kindDir, { recursive: true });
	const fileName = entryFileName(title, now);
	const filePath = join(kindDir, fileName);

	// 去重：同目录下任一文件的 frontmatter/标题行命中同名即视为重复。
	if (existsSync(kindDir)) {
		for (const existing of readdirSync(kindDir)) {
			if (!existing.endsWith(".md")) continue;
			try {
				const text = readFileSync(join(kindDir, existing), "utf-8");
				if (text.includes(`title: ${title}\n`) || text.includes(`# ${title}\n`)) {
					return { status: "duplicate", path: join(kindDir, existing) };
				}
			} catch {
				/* 单个文件读失败不影响整体 */
			}
		}
	}

	const frontmatter = [
		"---",
		`kind: ${entry.kind}`,
		`category: ${entry.category.trim() || "misc"}`,
		`title: ${title}`,
		`date: ${now.toISOString().slice(0, 10)}`,
		`tags: [${["knowledge-forge", ...sanitizeList(entry.tags)].join(", ")}]`,
		entry.sourceSessions && entry.sourceSessions.length > 0
			? `source_sessions: [${entry.sourceSessions.slice(0, 5).join(", ")}]`
			: undefined,
		"---",
		"",
	]
		.filter((line) => line !== undefined)
		.join("\n");

	const fileContent = `${frontmatter}# ${title}\n\n${content}\n`;

	// 原子写：临时文件 + rename，半写状态不会进库。
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, fileContent, "utf-8");
	renameSync(tmp, filePath);

	updateIndex(root, entry, fileName, now);
	return { status: "saved", path: filePath };
}

/** 追加 INDEX.md 索引行（按完整链接路径幂等——同名同日期的条目在不同
 * kind/类目下文件名相同，裸文件名做键会互相误伤）。 */
function updateIndex(root: string, entry: LibraryEntry, fileName: string, now: Date): void {
	const indexPath = join(root, "INDEX.md");
	const category = entry.category.trim() || "misc";
	const sectionHeader = `## ${entry.kind === "knowledge" ? "知识" : "技能"} · ${category}`;
	const relLink = `./${kindDirName(entry.kind)}/${categoryDir(category)}/${fileName}`;
	const line = `- [${entry.title}](${relLink}) — ${now.toISOString().slice(0, 10)}`;
	let text = "# Knowledge Forge Index\n\n由 knowledge-forge 自动沉淀的知识与技能库。\n";
	if (existsSync(indexPath)) {
		try {
			text = readFileSync(indexPath, "utf-8");
		} catch {
			/* 读失败则重建 */
		}
	}
	if (text.includes(relLink)) return;
	if (!text.includes(sectionHeader)) {
		text = `${text.trimEnd()}\n\n${sectionHeader}\n\n${line}\n`;
	} else {
		text = text.replace(sectionHeader, `${sectionHeader}\n${line}`);
	}
	writeFileSync(indexPath, text, "utf-8");
}

export interface LibraryStats {
	knowledge: { categories: number; entries: number };
	skills: { categories: number; entries: number };
	recentTitles: string[];
}

/** 库统计（/knowledge status 展示）。 */
export function libraryStats(root: string): LibraryStats {
	const stats: LibraryStats = {
		knowledge: { categories: 0, entries: 0 },
		skills: { categories: 0, entries: 0 },
		recentTitles: [],
	};
	for (const kind of ["knowledge", "skills"] as const) {
		const kindDir = join(root, kind === "knowledge" ? "knowledge" : "skills");
		if (!existsSync(kindDir)) continue;
		const key = kind === "knowledge" ? "knowledge" : "skills";
		for (const category of readdirSync(kindDir, { withFileTypes: true })) {
			if (!category.isDirectory()) continue;
			const files = readdirSync(join(kindDir, category.name)).filter((f) => f.endsWith(".md"));
			stats[key].categories += 1;
			stats[key].entries += files.length;
			for (const f of files) stats.recentTitles.push(`${kind}/${category.name}/${f}`);
		}
	}
	stats.recentTitles = stats.recentTitles.sort().slice(-5).reverse();
	return stats;
}
