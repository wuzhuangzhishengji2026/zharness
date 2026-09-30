import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureBundledSopsInstalled,
	findSopDir,
	installBuiltinSop,
	installSopFromGitHub,
	listBuiltinSops,
	uninstallSop,
} from "../src/core/sop-install.js";
import { SOP_FILENAME, loadInstalledSops } from "../src/core/sop.js";

const tempRoots: string[] = [];

function makeTempDir(prefix = "zharness-sop-install-"): string {
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

describe("findSopDir", () => {
	it("finds <slug>/SOP.md at the repo root", () => {
		const repo = makeTempDir();
		mkdirSync(join(repo, "my-sop"), { recursive: true });
		writeFileSync(join(repo, "my-sop", SOP_FILENAME), "---\ndescription: d\n---\n");
		expect(findSopDir(repo, "my-sop")).toBe(join(repo, "my-sop"));
	});

	it("finds <slug>/SOP.md under common layouts (sops/, workflows/)", () => {
		const repo = makeTempDir();
		for (const layout of ["sops", "workflows"]) {
			mkdirSync(join(repo, layout, `sop-${layout}`), { recursive: true });
			writeFileSync(join(repo, layout, `sop-${layout}`, SOP_FILENAME), "---\ndescription: d\n---\n");
			expect(findSopDir(repo, `sop-${layout}`)).toBe(join(repo, layout, `sop-${layout}`));
		}
	});

	it("falls back to a bounded nested scan", () => {
		const repo = makeTempDir();
		mkdirSync(join(repo, "packages", "nested", "deep", "my-sop"), { recursive: true });
		writeFileSync(join(repo, "packages", "nested", "deep", "my-sop", SOP_FILENAME), "---\ndescription: d\n---\n");
		expect(findSopDir(repo, "my-sop")).toBe(join(repo, "packages", "nested", "deep", "my-sop"));
	});

	it("returns null when the slug is absent", () => {
		expect(findSopDir(makeTempDir(), "nope")).toBeNull();
	});
});

describe("installSopFromGitHub (offline validation)", () => {
	it("rejects non-GitHub sources without spawning git", async () => {
		const result = await installSopFromGitHub("site/open.feishu.cn", "x");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not a GitHub repository");
	});

	it("rejects invalid slugs", async () => {
		const result = await installSopFromGitHub("owner/repo", "../escape");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Invalid SOP slug");
	});
});

describe("bundled templates", () => {
	it("ships parseable SOPs (static with steps, dynamic with a script)", () => {
		const bundled = listBuiltinSops();
		expect(bundled.length).toBeGreaterThanOrEqual(4);
		for (const sop of bundled) {
			expect(sop.description).toBeTruthy();
			if (sop.kind === "dynamic") {
				expect(sop.scriptSource).toBeTruthy();
				expect(sop.steps).toEqual([]);
			} else {
				expect(sop.steps.length).toBeGreaterThan(0);
			}
		}
	});

	it("ships the dynamic-task workflow (kind: dynamic, script attached)", () => {
		const dyn = listBuiltinSops().find((s) => s.slug === "dynamic-task");
		expect(dyn).toBeDefined();
		expect(dyn!.kind).toBe("dynamic");
		expect(dyn!.scriptSource).toContain("agent(");
		expect(dyn!.scriptSource).toContain("interface Plan");
		expect(dyn!.args.map((a) => a.name)).toEqual(["task", "constraints"]);
	});
});

describe("install / uninstall lifecycle", () => {
	it("installs a bundled SOP into <agentDir>/sops and uninstalls it", () => {
		const agentDir = makeTempDir("zharness-sop-agent-");
		const target = installBuiltinSop("dynamic-task", agentDir);
		expect(target).not.toBeNull();
		expect(existsSync(join(agentDir, "sops", "dynamic-task", SOP_FILENAME))).toBe(true);
		// 动态 SOP 的脚本随目录一起拷贝。
		expect(existsSync(join(agentDir, "sops", "dynamic-task", "workflow.ts"))).toBe(true);
		const installed = loadInstalledSops(agentDir).sops.find((s) => s.slug === "dynamic-task");
		expect(installed?.kind).toBe("dynamic");

		const removed = uninstallSop("dynamic-task", agentDir);
		expect(removed.ok).toBe(true);
		expect(existsSync(join(agentDir, "sops", "dynamic-task"))).toBe(false);

		// 卸载一个不存在的 SOP 是显式失败,不是静默成功。
		const again = uninstallSop("dynamic-task", agentDir);
		expect(again.ok).toBe(false);
	});

	it("returns null for an unknown bundled slug", () => {
		expect(installBuiltinSop("does-not-exist", makeTempDir("zharness-sop-agent-"))).toBeNull();
	});

	it("rejects path-traversal slugs on uninstall", () => {
		expect(uninstallSop("..", makeTempDir("zharness-sop-agent-")).ok).toBe(false);
	});
});

describe("ensureBundledSopsInstalled", () => {
	it("preinstalls all bundled SOPs and never overwrites local modifications", () => {
		const agentDir = makeTempDir("zharness-sop-agent-");
		ensureBundledSopsInstalled(agentDir);
		const installed = loadInstalledSops(agentDir).sops;
		expect(installed.length).toBeGreaterThanOrEqual(3);

		// 本地修改(新增文件)在再次预装后必须保留 —— 跳过已存在目录。
		const marker = join(agentDir, "sops", "deep-research", "local-note.txt");
		writeFileSync(marker, "keep me");
		ensureBundledSopsInstalled(agentDir);
		expect(existsSync(marker)).toBe(true);
	});
});
