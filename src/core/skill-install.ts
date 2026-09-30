/**
 * Install a skill from the skills.sh directory into `<agentDir>/skills/<slug>`.
 *
 * skills.sh entries point at a GitHub repository ("owner/repo" source) that
 * contains one or more skill directories, each identified by a `<slug>/SKILL.md`
 * file. We shallow-clone the repo into a temp dir, locate the skill directory
 * (common layouts + a bounded scan), then copy it into the agent skills root —
 * the same layout `installBuiltinSkill` uses, so the resource loader picks it
 * up as a user skill on the next load.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { execCommand } from "./exec.js";

export interface SkillInstallResult {
	ok: boolean;
	message: string;
}

/**
 * Recursive directory copy built from readdirSync + copyFileSync.
 *
 * Deliberately NOT fs.cpSync: on Windows with a non-ASCII (e.g. Chinese)
 * source path, Node's recursive cpSync can fail-fast the whole process
 * (0xC0000409) — the repo commonly lives under a localized Desktop path, so
 * bundling skills at rpc startup from there crashed the sidecar before it
 * could answer its first get_state. copyFileSync handles those paths fine.
 */
export function copyDirRecursive(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const src = join(source, entry.name);
		const dst = join(target, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(src, dst);
		} else if (entry.isFile()) {
			copyFileSync(src, dst);
		}
		// Symlinks/other specials are skipped — skill trees are plain files.
	}
}

/** skills.sh source that points at a GitHub repo (e.g. "vercel-labs/skills"). */
const GITHUB_SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * skills.sh pseudo-owners that stand for website-sourced skills rather than
 * GitHub repos (the leaderboard lists e.g. "site/open.feishu.cn/lark-doc").
 */
const NON_GITHUB_SOURCE_OWNERS = new Set(["site"]);

/** Slug sanity check (skills.sh slugs are URL-safe directory names). */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Common repo layouts where a skill directory may live (relative to repo root). */
const SKILL_DIR_CANDIDATES = [
	[],
	["skills"],
	[".claude", "skills"],
	[".agents", "skills"],
	["claude", "skills"],
	["skills", "claude"],
];

const SCAN_MAX_DEPTH = 5;
const SCAN_SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build"]);

/** True when the source looks like an installable GitHub "owner/repo" pair. */
export function isGitHubSource(source: string): boolean {
	const normalized = source.trim();
	if (!GITHUB_SOURCE_RE.test(normalized)) return false;
	return !NON_GITHUB_SOURCE_OWNERS.has(normalized.split("/")[0]);
}

/**
 * Locate `<slug>/SKILL.md` inside the cloned repo: try the common layouts
 * first, then a bounded depth-first scan as a fallback.
 */
export function findSkillDir(repoDir: string, slug: string): string | null {
	for (const segments of SKILL_DIR_CANDIDATES) {
		const candidate = join(repoDir, ...segments, slug);
		if (existsSync(join(candidate, "SKILL.md"))) return candidate;
	}
	const visit = (dir: string, depth: number): string | null => {
		if (depth > SCAN_MAX_DEPTH) return null;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (SCAN_SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (!isDir) continue;
			if (entry === slug && existsSync(join(full, "SKILL.md"))) return full;
			const nested = visit(full, depth + 1);
			if (nested) return nested;
		}
		return null;
	};
	return visit(repoDir, 1);
}

/**
 * Install the skill `slug` from GitHub repo `source` ("owner/repo") into
 * `<agentDir>/skills/<slug>`. Re-installing overwrites the previous copy so
 * users can update to the latest version.
 */
export async function installSkillFromDirectory(source: string, slug: string): Promise<SkillInstallResult> {
	const normalizedSource = source.trim();
	const normalizedSlug = slug.trim();
	if (!isGitHubSource(normalizedSource)) {
		return {
			ok: false,
			message: `Skill source "${normalizedSource}" is not a GitHub repository (expected owner/repo). Open the skill page to install it manually.`,
		};
	}
	if (!SLUG_RE.test(normalizedSlug)) {
		return { ok: false, message: `Invalid skill slug "${normalizedSlug}".` };
	}

	const tempDir = mkdtempSync(join(tmpdir(), "zharness-skill-"));
	try {
		const clone = await execCommand(
			"git",
			["clone", "--depth", "1", `https://github.com/${normalizedSource}.git`, "."],
			tempDir,
			{ timeout: 120_000 },
		);
		if (clone.code !== 0) {
			return {
				ok: false,
				message: `git clone https://github.com/${normalizedSource} failed (exit ${clone.code})${
					clone.stderr ? `:\n${clone.stderr.trim()}` : ""
				}`,
			};
		}
		const skillDir = findSkillDir(tempDir, normalizedSlug);
		if (!skillDir) {
			return {
				ok: false,
				message: `Skill "${normalizedSlug}" not found in https://github.com/${normalizedSource} (no ${normalizedSlug}/SKILL.md).`,
			};
		}
		const target = join(getAgentDir(), "skills", normalizedSlug);
		mkdirSync(join(getAgentDir(), "skills"), { recursive: true });
		rmSync(target, { recursive: true, force: true });
		copyDirRecursive(skillDir, target);
		return { ok: true, message: `Skill "${normalizedSlug}" installed to ${target}.` };
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 });
		} catch {
			// Non-fatal: temp dirs are cleaned by the OS eventually.
		}
	}
}
