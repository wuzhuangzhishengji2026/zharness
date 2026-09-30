import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSkillDir, installSkillFromDirectory, isGitHubSource } from "../src/core/skill-install.js";

const tempRoots: string[] = [];

function makeTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "zharness-skill-test-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("isGitHubSource", () => {
	it("accepts owner/repo pairs", () => {
		expect(isGitHubSource("vercel-labs/skills")).toBe(true);
		expect(isGitHubSource("anthropics/skills")).toBe(true);
	});

	it("rejects non-GitHub skills.sh sources", () => {
		// skills.sh also lists skills sourced from websites, not GitHub repos.
		expect(isGitHubSource("site/open.feishu.cn")).toBe(false);
		expect(isGitHubSource("")).toBe(false);
		expect(isGitHubSource("just-a-slug")).toBe(false);
	});
});

describe("findSkillDir", () => {
	it("finds <slug>/SKILL.md at the repo root", () => {
		const repo = makeTempRepo();
		mkdirSync(join(repo, "my-skill"), { recursive: true });
		writeFileSync(join(repo, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");

		expect(findSkillDir(repo, "my-skill")).toBe(join(repo, "my-skill"));
	});

	it("finds skills/<slug>/SKILL.md layout", () => {
		const repo = makeTempRepo();
		mkdirSync(join(repo, "skills", "other-skill"), { recursive: true });
		writeFileSync(join(repo, "skills", "other-skill", "SKILL.md"), "---\nname: other-skill\n---\n");

		expect(findSkillDir(repo, "other-skill")).toBe(join(repo, "skills", "other-skill"));
	});

	it("scans nested directories as a fallback", () => {
		const repo = makeTempRepo();
		mkdirSync(join(repo, "packages", "bundle", "deep-skill"), { recursive: true });
		writeFileSync(join(repo, "packages", "bundle", "deep-skill", "SKILL.md"), "---\nname: deep-skill\n---\n");

		expect(findSkillDir(repo, "deep-skill")).toBe(join(repo, "packages", "bundle", "deep-skill"));
	});

	it("returns null when the skill does not exist", () => {
		const repo = makeTempRepo();
		mkdirSync(join(repo, "skills", "present"), { recursive: true });
		writeFileSync(join(repo, "skills", "present", "SKILL.md"), "---\nname: present\n---\n");

		expect(findSkillDir(repo, "missing")).toBeNull();
	});

	it("ignores directories without SKILL.md and skipped dirs", () => {
		const repo = makeTempRepo();
		mkdirSync(join(repo, ".git", "missing"), { recursive: true });
		mkdirSync(join(repo, "missing"), { recursive: true });
		writeFileSync(join(repo, "missing", "README.md"), "no skill here");

		expect(findSkillDir(repo, "missing")).toBeNull();
	});
});

describe("installSkillFromDirectory validation (offline)", () => {
	it("rejects non-GitHub sources without spawning git", async () => {
		const result = await installSkillFromDirectory("site/open.feishu.cn", "lark-doc");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not a GitHub repository");
	});

	it("rejects invalid slugs", async () => {
		const result = await installSkillFromDirectory("vercel-labs/skills", "../escape");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Invalid skill slug");
	});
});
