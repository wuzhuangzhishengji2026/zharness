/**
 * Replay storage — read-only access to a session's local `replay-summary.json`
 * and its artifact files (ported from the dsh-replay2 host core).
 *
 * Layout on disk (per session, inside the workspace directory):
 *   <agentDir>/workspaces/<workspace_id>/replay/<sessionId>/
 *     replay-summary.json        ← authoritative replay source (schema 2.0)
 *     artifacts/…                ← round outputs (documents/code/diffs/logs…)
 *
 * Everything here is read-only: the replay summary is produced by the
 * replay-summary skill; this module only serves it to RPC / extensions.
 *
 * @module core/replay
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { getWorkspaceDir } from "../event-store/workspace.js";

/** The summary file name inside a replay session directory. */
export const REPLAY_SUMMARY_FILE = "replay-summary.json";

/**
 * Root directory holding all replay session directories of a workspace:
 *   <agentDir>/workspaces/<workspace_id>/replay/
 * NOTE: `getWorkspaceDir` creates the workspace dir when missing.
 */
export function getReplayRoot(workspaceId: string, agentDir?: string): string {
	return join(getWorkspaceDir(workspaceId, agentDir), "replay");
}

/**
 * Replay directory of one session:
 *   <agentDir>/workspaces/<workspace_id>/replay/<sessionId>/
 * The directory is NOT created here (read-only access); callers that produce
 * summaries create it themselves.
 */
export function getReplaySessionDir(workspaceId: string, sessionId: string, agentDir?: string): string {
	return join(getReplayRoot(workspaceId, agentDir), sessionId);
}

export type LoadSummaryResult =
	| { status: "found"; dir: string; summary: unknown }
	| { status: "missing" }
	| { status: "corrupt"; message: string };

/** One session that has a replay summary on disk. */
export interface ReplaySessionEntry {
	sessionId: string;
	/** Task name lifted from the summary ("" when unreadable). */
	taskName: string;
	/** Summary file mtime (ms epoch) — drives newest-first ordering. */
	updatedAt: number;
}

/**
 * Enumerate sessions with a replay summary under the workspace replay root,
 * newest first. The /replay picker must scan the replay root itself:
 * archived or imported replays (e.g. DSH exports) are not necessarily
 * present in the event store's session index.
 */
export async function listReplaySessions(workspaceId: string, agentDir?: string): Promise<ReplaySessionEntry[]> {
	const root = getReplayRoot(workspaceId, agentDir);
	let dirents;
	try {
		dirents = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ReplaySessionEntry[] = [];
	for (const d of dirents) {
		if (!d.isDirectory() || d.name.startsWith(".")) continue;
		const summaryPath = join(root, d.name, REPLAY_SUMMARY_FILE);
		try {
			const s = await stat(summaryPath);
			if (!s.isFile()) continue;
			let taskName = "";
			try {
				const parsed: unknown = JSON.parse(await readFile(summaryPath, "utf8"));
				const task = asRecord(asRecord(parsed)?.task);
				const name = task?.name;
				if (typeof name === "string") taskName = name;
			} catch {
				// Corrupt summary: still listed; the view reports the parse error.
			}
			out.push({ sessionId: d.name, taskName, updatedAt: s.mtimeMs });
		} catch {
			// No summary in this session dir — not a replay session.
		}
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Load and parse the replay summary inside a replay session directory.
 * Never throws: returns a discriminated result.
 */
export async function loadReplaySummary(dir: string): Promise<LoadSummaryResult> {
	let raw: string;
	try {
		raw = await readFile(join(dir, REPLAY_SUMMARY_FILE), "utf8");
	} catch {
		return { status: "missing" };
	}
	try {
		const summary = JSON.parse(raw) as unknown;
		return { status: "found", dir, summary };
	} catch (error) {
		return {
			status: "corrupt",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Resolve a relative artifact path inside the replay session dir.
 * Traversal outside the dir is denied (returns null).
 * @param dir replay session directory
 * @param rel artifact-relative path ('', 'artifacts/x.md', …)
 */
export function resolveInside(dir: string, rel: string): string | null {
	if (typeof rel !== "string") return null;
	if (rel.length === 0) return dir;
	const target = resolve(dir, rel);
	if (target !== dir && !target.startsWith(dir + sep)) return null;
	return target;
}

export interface ArtifactDirEntry {
	name: string;
	dir: boolean;
	size: number;
}

export type ListArtifactDirResult =
	| { ok: true; path: string; entries: ArtifactDirEntry[] }
	| { ok: false; reason: "missing" | "not_dir" | "denied" };

/** List one directory under the replay session dir (shallow). */
export async function listArtifactDir(dir: string, rel: string): Promise<ListArtifactDirResult> {
	const target = resolveInside(dir, rel);
	if (target === null) return { ok: false, reason: "denied" };
	try {
		const s = await stat(target);
		if (!s.isDirectory()) return { ok: false, reason: "not_dir" };
		const dirents = await readdir(target, { withFileTypes: true });
		const entries: ArtifactDirEntry[] = [];
		for (const d of dirents) {
			if (d.name.startsWith(".")) continue;
			let size = 0;
			let isDir = d.isDirectory();
			if (!isDir) {
				try {
					const fs = await stat(join(target, d.name));
					isDir = fs.isDirectory();
					size = fs.isFile() ? fs.size : 0;
				} catch {
					/* keep default */
				}
			}
			entries.push({ name: d.name, dir: isDir, size });
		}
		entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
		return { ok: true, path: target, entries };
	} catch {
		return { ok: false, reason: "missing" };
	}
}

/** Read a whole artifact file (cap guards local OOM; huge files are rejected). */
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export type ReadArtifactFileResult =
	| { ok: true; name: string; mime: string; data: Buffer }
	| { ok: false; reason: "missing" | "denied" | "not_file" | "too_large"; message?: string };

/** Read one artifact file under the replay session dir. */
export async function readArtifactFile(dir: string, rel: string): Promise<ReadArtifactFileResult> {
	const target = resolveInside(dir, rel);
	if (target === null) return { ok: false, reason: "denied" };
	let s;
	try {
		s = await stat(target);
	} catch {
		return { ok: false, reason: "missing" };
	}
	if (!s.isFile()) return { ok: false, reason: "not_file" };
	if (s.size > MAX_ARTIFACT_BYTES) {
		return {
			ok: false,
			reason: "too_large",
			message: `文件超过 ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB 上限，请直接打开`,
		};
	}
	try {
		const data = await readFile(target);
		return { ok: true, name: basename(target), mime: mimeOf(target), data };
	} catch (error) {
		return { ok: false, reason: "missing", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Content-type guess for artifact previews (fallback octet-stream). */
export function mimeOf(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	switch (ext) {
		case ".md":
		case ".markdown":
		case ".mdown":
			return "text/markdown; charset=utf-8";
		case ".txt":
		case ".log":
			return "text/plain; charset=utf-8";
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".json":
		case ".jsonc":
			return "application/json; charset=utf-8";
		case ".diff":
		case ".patch":
			return "text/x-diff; charset=utf-8";
		case ".js":
		case ".mjs":
		case ".cjs":
		case ".jsx":
			return "text/javascript; charset=utf-8";
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
			return "text/plain; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".xml":
		case ".svg":
			return "application/xml; charset=utf-8";
		case ".csv":
			return "text/csv; charset=utf-8";
		case ".yml":
		case ".yaml":
		case ".toml":
		case ".ini":
		case ".cfg":
		case ".conf":
			return "text/plain; charset=utf-8";
		case ".py":
		case ".java":
		case ".c":
		case ".h":
		case ".cpp":
		case ".hpp":
		case ".cc":
		case ".cs":
		case ".go":
		case ".rs":
		case ".rb":
		case ".php":
		case ".swift":
		case ".kt":
		case ".sh":
		case ".bat":
		case ".ps1":
		case ".sql":
			return "text/plain; charset=utf-8";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svgz":
			return "image/svg+xml";
		case ".pdf":
			return "application/pdf";
		case ".zip":
		case ".gz":
		case ".tar":
			return "application/octet-stream";
		default:
			return "application/octet-stream";
	}
}

/** Whether a mime is text-like (client can inline-preview). */
export function isTextualMime(mime: string): boolean {
	return mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || mime.includes("xml");
}
