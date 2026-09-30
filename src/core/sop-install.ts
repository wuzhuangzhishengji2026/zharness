/**
 * SOP 安装/卸载:GitHub 市场源与内置模板 → `<agentDir>/sops/<slug>/`。
 *
 * 与 skill-install.ts 同一套模式:浅克隆仓库 → 定位 `<slug>/SOP.md` →
 * 拷贝进 SOP 根目录,重装即更新。内置模板随应用分发(src/builtin-sops,
 * 构建期由 copy-assets / copy-binary-assets 落盘),启动时幂等预装。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.js";
import { getPackageDir, isBunBinary } from "../index.js";
import { execCommand } from "./exec.js";
import { copyDirRecursive, isGitHubSource } from "./skill-install.js";
import { SOP_FILENAME, isValidSopSlug, loadSopsFromDir, type Sop } from "./sop.js";

export interface SopInstallResult {
	ok: boolean;
	message: string;
}

/** 常见仓库布局:SOP 目录可能所在的相对位置(与技能目录同构)。 */
const SOP_DIR_CANDIDATES = [
	[],
	["sops"],
	[".zharness", "sops"],
	["sop"],
	["workflows"],
];

const SCAN_MAX_DEPTH = 5;
const SCAN_SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build"]);

/**
 * 定位克隆仓库中的 `<slug>/SOP.md`:先试常见布局,再做有界深度扫描。
 */
export function findSopDir(repoDir: string, slug: string): string | null {
	for (const segments of SOP_DIR_CANDIDATES) {
		const candidate = join(repoDir, ...segments, slug);
		if (existsSync(join(candidate, SOP_FILENAME))) return candidate;
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
			if (entry === slug && existsSync(join(full, SOP_FILENAME))) return full;
			const nested = visit(full, depth + 1);
			if (nested) return nested;
		}
		return null;
	};
	return visit(repoDir, 1);
}

/** skills.sh / 市场通用的 GitHub "owner/repo" 源判定(复用技能的规则)。 */
export { isGitHubSource };

/**
 * 从 GitHub 仓库 `source`(owner/repo)安装 SOP `slug` 到
 * `<agentDir>/sops/<slug>`。重装覆盖旧副本,即更新到最新版。
 */
export async function installSopFromGitHub(source: string, slug: string): Promise<SopInstallResult> {
	const normalizedSource = source.trim();
	const normalizedSlug = slug.trim();
	if (!isGitHubSource(normalizedSource)) {
		return {
			ok: false,
			message: `SOP source "${normalizedSource}" is not a GitHub repository (expected owner/repo).`,
		};
	}
	if (!isValidSopSlug(normalizedSlug)) {
		return { ok: false, message: `Invalid SOP slug "${normalizedSlug}".` };
	}

	const tempDir = mkdtempSync(join(tmpdir(), "zharness-sop-"));
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
		const sopDir = findSopDir(tempDir, normalizedSlug);
		if (!sopDir) {
			return {
				ok: false,
				message: `SOP "${normalizedSlug}" not found in https://github.com/${normalizedSource} (no ${normalizedSlug}/${SOP_FILENAME}).`,
			};
		}
		const target = installSopDir(sopDir, normalizedSlug);
		return { ok: true, message: `SOP "${normalizedSlug}" installed to ${target}.` };
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 });
		} catch {
			// Non-fatal: temp dirs are cleaned by the OS eventually.
		}
	}
}

/** 把一个 SOP 目录拷入 `<agentDir>/sops/<slug>`,返回目标路径。 */
function installSopDir(sourceDir: string, slug: string, agentDir?: string): string {
	const sopsRoot = join(agentDir ?? getAgentDir(), "sops");
	mkdirSync(sopsRoot, { recursive: true });
	const target = join(sopsRoot, slug);
	rmSync(target, { recursive: true, force: true });
	copyDirRecursive(sourceDir, target);
	return target;
}

/** 卸载 `<agentDir>/sops/<slug>`。内置来源的 SOP 同样可卸载(重装即恢复)。 */
export function uninstallSop(slug: string, agentDir?: string): SopInstallResult {
	const normalizedSlug = slug.trim();
	if (!isValidSopSlug(normalizedSlug)) {
		return { ok: false, message: `Invalid SOP slug "${normalizedSlug}".` };
	}
	const target = join(agentDir ?? getAgentDir(), "sops", normalizedSlug);
	if (!existsSync(target)) {
		return { ok: false, message: `SOP "${normalizedSlug}" is not installed.` };
	}
	try {
		rmSync(target, { recursive: true, force: true });
		return { ok: true, message: `SOP "${normalizedSlug}" uninstalled.` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Failed to uninstall SOP "${normalizedSlug}": ${message}` };
	}
}

/**
 * 内置 SOP 模板根目录。
 * - Bun 二进制:`builtin-sops/` 紧邻可执行文件(copy-binary-assets)
 * - Node dist / src 开发:dist/src/core → dist/src/builtin-sops
 *   (copy-assets 落盘;本模块在 core/ 下,比 builtin-extensions 深一层)
 */
export function getBuiltinSopsRoot(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "builtin-sops");
	}
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "builtin-sops");
}

/** 列出内置模板(解析每个 <id>/SOP.md 的元信息;解析失败的不进市场)。 */
export function listBuiltinSops(): Sop[] {
	return loadSopsFromDir(getBuiltinSopsRoot()).sops;
}

/** 拷贝一个内置模板到 SOP 根目录。返回 null 表示该模板不存在。 */
export function installBuiltinSop(slug: string, agentDir?: string): string | null {
	const source = join(getBuiltinSopsRoot(), slug);
	if (!existsSync(join(source, SOP_FILENAME))) return null;
	return installSopDir(source, slug, agentDir);
}

/** 启动期幂等预装全部内置模板(已存在则跳过,不覆盖本地修改)。 */
export function ensureBundledSopsInstalled(agentDir?: string): void {
	for (const sop of listBuiltinSops()) {
		try {
			const target = join(agentDir ?? getAgentDir(), "sops", sop.slug);
			if (existsSync(join(target, SOP_FILENAME))) continue;
			installSopDir(join(getBuiltinSopsRoot(), sop.slug), sop.slug, agentDir);
		} catch {
			// Non-fatal — the market tab still offers a manual install.
		}
	}
}
