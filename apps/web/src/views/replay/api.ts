/**
 * /replay — data access over the ZHarness JSON-RPC replay commands
 * (get_replay_summary / list_replay_dir / read_replay_file), replacing the
 * dsh-replay2 HTTP routes. Read-only; failures propagate the
 * sendCommandAwait rejection as-is.
 */

import { sendCommandAwait } from "@/lib/transport";

const FILE_TIMEOUT_MS = 30_000;

export interface ReplayDirEntry {
	name: string;
	dir: boolean;
	size: number;
}

export interface ReplayDirListing {
	path: string;
	entries: ReplayDirEntry[];
}

export interface ReplayFileContent {
	name: string;
	mime: string;
	size: number;
	text?: string;
	blobUrl?: string;
}

interface RawReplayFile {
	name: string;
	mime: string;
	size: number;
	data: string; // base64
}

/** Fetch the replay summary for one conversation (null when absent). */
export async function fetchSummary(sessionId: string): Promise<unknown | null> {
	const r = await sendCommandAwait<{ sessionId: string; summary: unknown | null }>({
		type: "get_replay_summary",
		sessionId,
	});
	return r.data?.summary ?? null;
}

export interface ReplaySessionEntry {
	sessionId: string;
	taskName: string;
	updatedAt: number;
}

/**
 * List sessions that actually have a replay summary in this workspace.
 * Archived / imported replays may be absent from the history tree, so the
 * /replay picker is driven by this list, not by historyTreeList.
 */
export async function fetchReplaySessions(): Promise<ReplaySessionEntry[]> {
	const r = await sendCommandAwait<{ sessions: ReplaySessionEntry[] }>({ type: "list_replay_sessions" });
	return r.data?.sessions ?? [];
}

/** List one artifact directory (shallow). */
export async function fetchDir(sessionId: string, rel: string): Promise<ReplayDirListing> {
	const r = await sendCommandAwait<ReplayDirListing>({
		type: "list_replay_dir",
		sessionId,
		path: rel,
	});
	if (r.data === undefined) throw new Error("list_replay_dir: empty response");
	return r.data;
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	const bin = atob(data);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function readRawFile(sessionId: string, rel: string): Promise<RawReplayFile> {
	const r = await sendCommandAwait<RawReplayFile>(
		{ type: "read_replay_file", sessionId, path: rel },
		FILE_TIMEOUT_MS,
	);
	if (r.data === undefined) throw new Error("read_replay_file: empty response");
	return r.data;
}

/**
 * Fetch an artifact file and decide how to render it: text-like payloads are
 * decoded to `text`, everything else becomes an object URL (`blobUrl`).
 */
export async function fetchFile(sessionId: string, rel: string): Promise<ReplayFileContent> {
	const { name, mime, size, data } = await readRawFile(sessionId, rel);
	const bytes = base64ToBytes(data);
	const textLike =
		mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || mime.includes("xml");
	if (textLike) {
		return { name, mime, size, text: new TextDecoder("utf-8").decode(bytes) };
	}
	const blob = new Blob([bytes], { type: mime });
	return { name, mime, size, blobUrl: URL.createObjectURL(blob) };
}

/** Fetch an artifact file and trigger a browser download. */
export async function downloadFile(sessionId: string, rel: string): Promise<void> {
	const { name, mime, data } = await readRawFile(sessionId, rel);
	const bytes = base64ToBytes(data);
	const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
