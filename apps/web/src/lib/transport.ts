/**
 * Transport abstraction — detects Tauri vs browser and provides
 * a unified API for sending commands and receiving events.
 *
 * In Tauri: uses `invoke` + `listen` (Rust bridge to sidecar).
 * In browser: uses HTTP POST + SSE to the dev bridge plugin.
 */

import type {
	WorkspaceMeta,
	RpcHistoryTreeNode,
	RpcHistorySessionView,
	RpcForensicEvent,
	RpcContextPreviewData,
	RpcContextOverridesSnapshot,
	RpcContextScoreStatus,
	RpcOverrideScope,
} from "./types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- Command sending ---

export async function sendCommandRaw(command: Record<string, unknown>): Promise<string> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<string>("rpc_command", { command });
	}
	await fetch("/rpc/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(command),
	});
	return (command.id as string) ?? Math.random().toString(36).slice(2);
}

export interface RpcResponse<T = unknown> {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: T;
}

export async function sendCommandAwait<T = unknown>(
	command: Record<string, unknown>,
	timeoutMs = 15000,
): Promise<RpcResponse<T>> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		// Generate the ID BEFORE sending so the listener can match the response
		// immediately, even if the sidecar responds before sendCommandRaw resolves.
		const id = (command.id as string) ?? crypto.randomUUID();
		command.id = id;
		return new Promise((resolve, reject) => {
			// Tear the listener down exactly once. Several paths race to finish a
			// request (matching response, timeout, send error) and, on page
			// reload, Tauri's internal registry may already be gone — both cases
			// otherwise surface as `listeners[eventId].handlerId` errors.
			let settled = false;
			let unlistenFn: (() => void) | null = null;
			const cleanup = () => { try { unlistenFn?.(); } catch { /* registry gone (reload) */ } };
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				fn();
			};
			const timer = setTimeout(() => {
				finish(() => reject(new Error(`Command "${command.type}" timed out after ${timeoutMs}ms`)));
			}, timeoutMs);
			listen<RpcResponse<T>>("rpc_response", (event) => {
				const payload = event.payload;
				if (payload.id !== id) return;
				finish(() => {
					if (payload.success) {
						resolve(payload);
					} else {
						reject(new Error(payload.error ?? `Command "${command.type}" failed`));
					}
				});
			})
				.then((fn) => {
					// If the request already finished (e.g. timed out) before
					// registration resolved, tear the listener down immediately.
					if (settled) { try { fn(); } catch { /* ignore */ } }
					else unlistenFn = fn;
				})
				.catch(() => { /* registration failed (reload) — swallow */ });
			sendCommandRaw(command).catch((e) => {
				finish(() => reject(e));
			});
		});
	}
	// Browser: generate id, register waiter BEFORE sending to avoid race
	const id = (command.id as string) ?? crypto.randomUUID();
	command.id = id;
	ensureSse();
	const promise = waitForResponse<T>(id, timeoutMs, String(command.type));
	await sendCommandRaw(command);
	return promise;
}

// --- Event subscription ---

export type EventHandler = (event: Record<string, unknown>) => void;
export type ExitHandler = (code: number | null, cwd?: string) => void;

export async function subscribeEvents(handler: EventHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		// Await registration and swallow failures so a reload-time rejection is
		// never unhandled; the returned unlisten is guarded against a torn-down
		// registry (`listeners[eventId].handlerId`).
		const unlisten = await listen("rpc_event", (event) => handler(event.payload as Record<string, unknown>)).catch(() => null);
		return () => { try { unlisten?.(); } catch { /* registry gone (reload) */ } };
	}
	// Browser: SSE
	return subscribeSse(handler);
}

export async function subscribeSidecarExit(handler: ExitHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		const unlisten = await listen<{ code: number | null; cwd?: string }>("sidecar_exit", (event) => handler(event.payload.code, event.payload.cwd)).catch(() => null);
		return () => { try { unlisten?.(); } catch { /* registry gone (reload) */ } };
	}
	// Browser: no sidecar exit concept, but we can detect fetch errors
	return () => {};
}

// --- Extension UI requests (confirm/input dialogs from extensions) ---
//
// The sidecar emits `extension_ui_request` lines when an extension needs
// user interaction (e.g. codegen pipeline confirm points). The Rust bridge
// re-emits them as a dedicated Tauri event tagged with `_cwd`; the browser
// dev bridge forwards them over the shared SSE stream like any other line.

export async function subscribeExtensionUIRequests(handler: EventHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		const unlisten = await listen("extension_ui_request", (event) => handler(event.payload as Record<string, unknown>)).catch(() => null);
		return () => { try { unlisten?.(); } catch { /* registry gone (reload) */ } };
	}
	// Browser: SSE carries every stdout line — filter to UI requests here.
	return subscribeSse((line) => {
		if (line && typeof line === "object" && (line as Record<string, unknown>).type === "extension_ui_request") {
			handler(line as Record<string, unknown>);
		}
	});
}

/**
 * Respond to an extension UI request. Fire-and-forget: the sidecar does
 * not acknowledge `extension_ui_response` lines, so sendCommandAwait
 * (which waits for a matching response line) must not be used here.
 */
export async function sendExtensionUIResponse(response: Record<string, unknown>): Promise<void> {
	await sendCommandRaw(response);
}

// --- Init ---

export async function initSidecar(cwd?: string): Promise<Record<string, unknown> | null> {
	if (isTauri()) {
		const core = await import("@tauri-apps/api/core");
		const result = await core.invoke<string>("init_sidecar", { cwd: cwd ?? null });
		let parsed = result;
		if (typeof parsed === "string") {
			parsed = JSON.parse(parsed);
		}
		const state = (parsed as unknown as Record<string, unknown>)?.data ?? parsed ?? null;
		return state as Record<string, unknown> | null;
	}
	// Browser: GET /rpc/init — bridge sends get_state and returns response.
	// ?cwd= asks the bridge to switch its sidecar to that workspace first
	// (网页端的「选择项目」).
	try {
		const url = cwd ? `/rpc/init?cwd=${encodeURIComponent(cwd)}` : "/rpc/init";
		const resp = await fetch(url);
		if (!resp.ok) {
			console.error("[init] /rpc/init failed:", resp.status);
			return null;
		}
		const json = await resp.json();
		return json.data ?? null;
	} catch (e) {
		console.error("[init] fetch /rpc/init error:", e);
		return null;
	}
}

// --- New workspace (Tauri only) ---

export async function newWorkspace(): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("new_workspace");
}

// --- List workspaces ---

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
	if (isTauri()) {
		const core = await import("@tauri-apps/api/core");
		const result = await core.invoke<WorkspaceMeta[]>("list_workspaces");
		return result;
	}
	// Browser: dev-bridge scans ~/.zharness/agent/workspaces/*/meta.json
	// (mirror of the Rust list_workspaces command).
	try {
		const resp = await fetch("/rpc/workspaces");
		if (!resp.ok) return [];
		return (await resp.json()) as WorkspaceMeta[];
	} catch {
		return [];
	}
}

// --- History tree / event forensics (right dock) ---

/**
 * 分支树列表。`sessionId` = 联动锚点:GUI 查看历史对话时按目标所属
 * 对话(线程)取树;不传则取活跃对话的树。
 */
export async function historyTreeList(query?: string, sessionId?: string): Promise<RpcHistoryTreeNode[]> {
	const r = await sendCommandAwait<{ action: "list"; nodes: RpcHistoryTreeNode[] }>({ type: "history_tree", action: "list", query, sessionId });
	return r.data?.nodes ?? [];
}

export async function historyTreeView(sessionId: string, maxMessages?: number): Promise<RpcHistorySessionView | null> {
	const r = await sendCommandAwait<{ action: "view"; view: RpcHistorySessionView | null }>({ type: "history_tree", action: "view", sessionId, maxMessages });
	return r.data?.view ?? null;
}

export async function historyTreeJump(sessionId: string, reason?: string): Promise<{ session_id: string; reopened: boolean }> {
	const r = await sendCommandAwait<{ action: "jump"; session_id: string; reopened: boolean }>({ type: "history_tree", action: "jump", sessionId, reason });
	return { session_id: r.data?.session_id ?? sessionId, reopened: r.data?.reopened ?? false };
}

export async function historyTreeFork(sessionId: string): Promise<{ session_id: string }> {
	const r = await sendCommandAwait<{ action: "fork"; session_id: string }>({ type: "history_tree", action: "fork", sessionId });
	return { session_id: r.data?.session_id ?? sessionId };
}

export async function historyTreeRename(sessionId: string, name: string): Promise<void> {
	await sendCommandAwait({ type: "history_tree", action: "rename", sessionId, name });
}

// --- Sessions across workspaces (sidebar mapping) ---

export interface SidebarSessionInfo {
	workspace_id: string;
	cwd: string;
	session_id: string;
	/** 同对话分组内的全部会话 id(侧栏按首条用户消息聚合 fork/续写会话)。 */
	session_ids?: string[];
	name?: string;
	title: string;
	created_at: number;
	parent_session_id?: string;
}

/** 每个工作区(含主对话工作区)的会话摘要,供侧栏把历史会话映射到项目下。 */
export async function listAllSessions(): Promise<SidebarSessionInfo[]> {
	const r = await sendCommandAwait<{ sessions?: SidebarSessionInfo[] }>({ type: "list_sessions" }, 30000);
	return r.data?.sessions ?? [];
}

// --- Codegen pipeline (codegen-sma; RightDock panel) ---

export interface CodegenStageRecord {
	stage: string;
	attempt: number;
	status: "passed" | "failed" | "blocked" | "user-rejected";
	summary?: string;
	evidence?: string;
	changedFiles?: string[];
}

export interface CodegenState {
	goal: string;
	stageIndex: number;
	attempt: number;
	stageOrder: string[];
	records: CodegenStageRecord[];
	startedAt: string;
	finishedAt?: string;
	outcome?: "completed" | "blocked" | "abandoned" | "aborted";
}

export interface CodegenStatusResult {
	state: CodegenState | null;
	running: boolean;
}

export async function codegenStatus(): Promise<CodegenStatusResult> {
	const r = await sendCommandAwait<CodegenStatusResult>({ type: "codegen", action: "status" });
	return r.data ?? { state: null, running: false };
}

export async function codegenStart(goal: string): Promise<CodegenStatusResult> {
	const r = await sendCommandAwait<CodegenStatusResult>({ type: "codegen", action: "start", goal });
	return r.data ?? { state: null, running: true };
}

export async function codegenResume(): Promise<CodegenStatusResult> {
	const r = await sendCommandAwait<CodegenStatusResult>({ type: "codegen", action: "resume" });
	return r.data ?? { state: null, running: true };
}

export async function codegenAbort(): Promise<CodegenStatusResult> {
	const r = await sendCommandAwait<CodegenStatusResult>({ type: "codegen", action: "abort" });
	return r.data ?? { state: null, running: false };
}

// ---- Context editor (context-editor built-in extension) ----

export async function contextPreview(pendingUserMessage?: string): Promise<RpcContextPreviewData | null> {
	const r = await sendCommandAwait<RpcContextPreviewData>(
		{ type: "context_preview", ...(pendingUserMessage ? { pendingUserMessage } : {}) },
		30000,
	);
	return r.data ?? null;
}

export interface ContextApplyInput {
	systemPrompt?: { text: string; scope: RpcOverrideScope } | null;
	messageEdits?: Array<{
		eventId: string;
		action: "edit" | "delete" | "clear";
		text?: string;
		scope: RpcOverrideScope;
	}>;
}

export async function contextApply(input: ContextApplyInput): Promise<RpcContextOverridesSnapshot | null> {
	const r = await sendCommandAwait<RpcContextOverridesSnapshot>({ type: "context_apply", ...input }, 30000);
	return r.data ?? null;
}

export async function contextOverridesClear(
	target?: "all" | "systemPrompt" | "messageEdits",
): Promise<RpcContextOverridesSnapshot | null> {
	const r = await sendCommandAwait<RpcContextOverridesSnapshot>(
		{ type: "context_overrides_clear", ...(target ? { target } : {}) },
		30000,
	);
	return r.data ?? null;
}

// --- Context scoring (LLM background job; poll status) ---

export async function contextScoreStart(
	pendingUserMessage?: string,
	force = false,
): Promise<RpcContextScoreStatus | null> {
	const r = await sendCommandAwait<RpcContextScoreStatus>(
		{
			type: "context_score",
			action: "start",
			force,
			...(pendingUserMessage ? { pendingUserMessage } : {}),
		},
		30000,
	);
	return r.data ?? null;
}

export async function contextScoreStatus(
	pendingUserMessage?: string,
): Promise<RpcContextScoreStatus | null> {
	const r = await sendCommandAwait<RpcContextScoreStatus>(
		{ type: "context_score", action: "status", ...(pendingUserMessage ? { pendingUserMessage } : {}) },
		15000,
	);
	return r.data ?? null;
}

export async function contextScoreCancel(): Promise<RpcContextScoreStatus | null> {
	const r = await sendCommandAwait<RpcContextScoreStatus>({ type: "context_score", action: "cancel" }, 15000);
	return r.data ?? null;
}

/** 拉取事件流。sessionId:限定该会话所属「对话」的事件(查看模式);不传则全工作区。 */
export async function getEvents(opts?: { eventTypes?: string[]; limit?: number; sessionScoped?: boolean; sessionId?: string }): Promise<RpcForensicEvent[]> {
	const r = await sendCommandAwait<{ events: RpcForensicEvent[] }>({ type: "get_events", ...opts }, 30000);
	return r.data?.events ?? [];
}

/** Fork/rewind at a specific event id (used for "replay from here"). */
export async function rewindToEvent(targetEventId: string): Promise<void> {
	await sendCommandAwait({ type: "rewind", targetEventId });
}

export interface BashRunResult {
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
}

export async function runBash(command: string): Promise<BashRunResult> {
	const r = await sendCommandAwait<BashRunResult>({ type: "bash", command }, 120000);
	return r.data ?? { output: "", cancelled: false, truncated: false };
}

export async function abortBash(): Promise<void> {
	try { await sendCommandAwait({ type: "abort_bash" }, 5000); } catch { /* ignore */ }
}

// --- Tool approval (safe mode) ---

/** Approve a pending tool call awaiting user approval. */
export async function approveToolCall(intentEventId: string): Promise<void> {
	try {
		await sendCommandAwait({ type: "approve", intentEventId }, 5000);
	} catch { /* ignore */ }
}

/** Reject (deny) a pending tool call awaiting user approval. */
export async function rejectToolCall(intentEventId: string): Promise<void> {
	try {
		await sendCommandAwait({ type: "reject", intentEventId }, 5000);
	} catch { /* ignore */ }
}

/** Toggle safe mode (master switch for requiring tool approval). */
export async function setSafeMode(enabled: boolean): Promise<boolean> {
	const r = await sendCommandAwait<{ safeMode: boolean }>({ type: "set_safe_mode", enabled }, 5000);
	return r.data?.safeMode ?? enabled;
}
export interface SkillInfo {
	command: string;
	name: string;
	description?: string;
}

/** Start a new conversation session (clears context for a fresh task). */
export async function newSession(): Promise<string | null> {
	try {
		const r = await sendCommandAwait<{ sessionId: string }>({ type: "new_session" }, 5000);
		return r.data?.sessionId ?? null;
	} catch (e) {
		console.error("[composer] new_session failed", e);
		return null;
	}
}

/** List available skills (invocable as slash commands). */
export async function getSkills(): Promise<SkillInfo[]> {
	try {
		const r = await sendCommandAwait<{ skills: SkillInfo[] }>({ type: "get_skills" }, 10000);
		return r.data?.skills ?? [];
	} catch {
		return [];
	}
}

export type ExtensionKind = "builtin" | "user" | "project" | "cli" | "package";

export interface ExtensionInfo {
	id: string;
	name: string;
	description?: string;
	kind: ExtensionKind;
	enabled: boolean;
	canToggle: boolean;
	installable: boolean;
	installed: boolean;
	path: string;
	toolCount: number;
	commandCount: number;
}

/** List all extensions (built-in + user-installed), including disabled built-ins. */
export async function getExtensions(): Promise<ExtensionInfo[]> {
	try {
		const r = await sendCommandAwait<{ extensions: ExtensionInfo[] }>({ type: "get_extensions" }, 10000);
		return r.data?.extensions ?? [];
	} catch {
		return [];
	}
}

/** Enable or disable a built-in extension. Returns whether a reload is required. */
export async function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
	const r = await sendCommandAwait<{ requiresReload: boolean }>(
		{ type: "set_extension_enabled", extensionId: id, enabled },
		5000,
	);
	return r.data?.requiresReload ?? true;
}

/** Install an extension's external dependency (e.g. the agent-browser CLI). Long-running. */
export async function installExtension(
	id: string,
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string; installed: boolean }>(
		{ type: "install_extension", extensionId: id },
		600000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "", installed: r.data?.installed ?? false };
}

/** Uninstall an extension's external dependency. */
export async function uninstallExtension(
	id: string,
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string; installed: boolean }>(
		{ type: "uninstall_extension", extensionId: id },
		120000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "", installed: r.data?.installed ?? false };
}


/**
 * Open a URL in the system browser. In the Tauri desktop shell window.open is a silent no-op, so route through the shell plugin there (the shell:allow-open capability is already granted).
 */
export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		const shell = await import("@tauri-apps/plugin-shell");
		await shell.open(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Install a skill from the skills.sh directory (GitHub "owner/repo" source +
 * skill slug) into the agent skills directory. Long-running (git clone).
 */
export async function installSkill(
	source: string,
	slug: string,
): Promise<{ ok: boolean; message: string }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string }>(
		{ type: "install_skill", source, slug },
		300000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "" };
}

// --- Skills.sh directory ---

export interface SkillsShSkill {
	id: string;
	source: string;
	slug: string;
	name: string;
	url: string;
	installUrl?: string;
	installs?: number;
}

/**
 * Fetch skill directory from skills.sh by scraping the HTML leaderboard.
 * The official API requires Vercel OIDC auth, but the HTML page contains
 * all skill links rendered server-side.
 */
export async function fetchSkillsSh(): Promise<SkillsShSkill[]> {
	try {
		let html: string;
		if (isTauri()) {
			const core = await import("@tauri-apps/api/core");
			html = await core.invoke<string>("fetch_skills_sh");
		} else {
			// 浏览器直连 skills.sh 会被 CORS 拦截,改走 dev-bridge 的 Node 侧代理。
			const res = await fetch("/rpc/skills-sh", {
				headers: { Accept: "text/html" },
			});
			if (!res.ok) return [];
			html = await res.text();
		}
		const seen = new Set<string>();
		const skills: SkillsShSkill[] = [];
		const linkRegex = /href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/g;
		let match: RegExpExecArray | null;
		while ((match = linkRegex.exec(html)) !== null) {
			const link = "/" + match[1];
			if (link.startsWith("/_next") || seen.has(link)) continue;
			seen.add(link);
			const parts = link.slice(1).split("/");
			const source = parts.slice(0, -1).join("/");
			const slug = parts[parts.length - 1];
			skills.push({
				id: `${source}/${slug}`,
				source,
				slug,
				name: slug,
				url: `https://www.skills.sh${link}`,
				installUrl: `https://github.com/${source}`,
			});
		}
		return skills;
	} catch {
		return [];
	}
}

// --- Delete workspace (Tauri only) ---

export async function deleteWorkspace(workspaceId: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("delete_workspace", { workspaceId });
}

// --- SOP market ---

/** An installed SOP workflow template (from <agentDir>/sops). */
export interface SopInfo {
	slug: string;
	name: string;
	description?: string;
	version?: string;
	author?: string;
	tags: string[];
	/** "static" = declarative steps; "dynamic" = workflow.ts script orchestrating subagents. */
	kind: "static" | "dynamic";
	args: Array<{ name: string; required: boolean }>;
	stepCount: number;
	path: string;
}

/** A market directory entry (bundled template or installed-from-GitHub). */
export interface SopMarketEntry {
	slug: string;
	name: string;
	description?: string;
	version?: string;
	author?: string;
	tags: string[];
	/** "static" = declarative steps; "dynamic" = workflow.ts script orchestrating subagents. */
	kind: "static" | "dynamic";
	stepCount: number;
	/** "builtin" or "github:<owner/repo>". */
	source: string;
	installed: boolean;
}

/** List installed SOP workflow templates. */
export async function getSops(): Promise<SopInfo[]> {
	try {
		const r = await sendCommandAwait<{ sops: SopInfo[] }>({ type: "sop_list" }, 10000);
		return r.data?.sops ?? [];
	} catch {
		return [];
	}
}

/** Fetch the SOP market directory (bundled templates + installed flags). */
export async function getSopMarket(): Promise<SopMarketEntry[]> {
	try {
		const r = await sendCommandAwait<{ entries: SopMarketEntry[] }>({ type: "sop_market" }, 10000);
		return r.data?.entries ?? [];
	} catch {
		return [];
	}
}

/**
 * Install a SOP workflow template: `source` is "builtin" for bundled
 * templates or a GitHub "owner/repo" (git clone, long-running).
 */
export async function installSop(
	source: string,
	slug: string,
): Promise<{ ok: boolean; message: string }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string }>(
		{ type: "sop_install", source, slug },
		300000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "" };
}

/** Uninstall an installed SOP (bundled ones can be reinstalled any time). */
export async function uninstallSop(slug: string): Promise<{ ok: boolean; message: string }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string }>(
		{ type: "sop_uninstall", slug },
		10000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "" };
}

// --- Reveal workspace in file manager (Tauri only) ---

export async function revealWorkspace(cwd: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("reveal_workspace", { cwd });
}

// --- File explorer (Tauri only) ---

export interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number;
}

export async function listDir(cwd: string, subPath?: string): Promise<DirEntry[]> {
	if (!isTauri()) return [];
	const core = await import("@tauri-apps/api/core");
	return core.invoke<DirEntry[]>("list_dir", { cwd, subPath: subPath ?? null });
}

export async function readFileContent(cwd: string, filePath: string): Promise<string> {
	if (!isTauri()) return "";
	const core = await import("@tauri-apps/api/core");
	return core.invoke<string>("read_file", { cwd, filePath });
}

export async function openInEditor(cwd: string, filePath: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("open_in_editor", { cwd, filePath });
}

export async function revealPath(cwd: string, subPath: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("reveal_path", { cwd, subPath });
}

// --- Provider management (Tauri only) ---

export interface ProviderInfo {
	id: string;
	/** Human-readable display name (from pi-ai built-ins); falls back to id. */
	name?: string;
	has_api_key: boolean;
	auth_type: string | null;
}

export async function listProviders(): Promise<ProviderInfo[]> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/providers");
		if (!resp.ok) return [];
		return resp.json();
	}
	const core = await import("@tauri-apps/api/core");
	return core.invoke<ProviderInfo[]>("list_providers");
}

export async function setProviderApiKey(provider: string, apiKey: string): Promise<void> {
	if (!isTauri()) {
		await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider, apiKey }),
		});
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("set_provider_api_key", { provider, apiKey });
}

export async function removeProviderApiKey(provider: string): Promise<void> {
	if (!isTauri()) {
		await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider, remove: true }),
		});
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("remove_provider_api_key", { provider });
}

// --- Custom OpenAI-compatible provider (URL + API key) ---
//
// Adds/removes a provider entry in `~/.zharness/agent/models.json` via the Tauri
// bridge. In Tauri, the webview is sandboxed so the actual file write happens
// in Rust (`bridge::add_custom_provider` / `bridge::remove_custom_provider`)
// and the bridge then broadcasts `reload_providers` to every sidecar.
//
// Outside Tauri (web preview), we fall back to the same `/rpc/providers`
// endpoint, which the dev plugin already serves for built-in providers.

export interface CustomProviderInfo {
	id: string;
}

export async function addCustomProvider(
	name: string,
	baseUrl: string,
	apiKey: string | null,
	modelIds: string[],
	contextWindow?: number,
	api?: string,
): Promise<void> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "add_custom", name, baseUrl, apiKey, modelIds, contextWindow, api }),
		});
		if (!resp.ok) throw new Error(await resp.text());
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("add_custom_provider", { name, baseUrl, apiKey, modelIds, contextWindow, api });
}

export async function removeCustomProvider(name: string): Promise<void> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "remove_custom", name }),
		});
		if (!resp.ok) throw new Error(await resp.text());
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("remove_custom_provider", { name });
}

/**
 * Fetch the available model ids from `{baseUrl}/models` for the "Custom"
 * provider form. Under Tauri the call goes through Rust because the webview
 * CORS sandbox blocks cross-origin requests. In the browser we hit
 * `${baseUrl}/models` directly; the form falls back to manual id input on
 * any failure so a CORS error is non-fatal.
 */
export async function fetchCustomProviderModels(
	baseUrl: string,
	apiKey: string | null,
): Promise<CustomProviderInfo[]> {
	if (isTauri()) {
		const core = await import("@tauri-apps/api/core");
		try {
			return await core.invoke<CustomProviderInfo[]>("fetch_openai_models", { baseUrl, apiKey });
		} catch {
			return [];
		}
	}
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const resp = await fetch(baseUrl.replace(/\/+$/, "") + "/models", { method: "GET", headers });
		if (!resp.ok) return [];
		const body = (await resp.json()) as { data?: Array<{ id?: unknown }> };
		if (!body || !Array.isArray(body.data)) return [];
		return body.data
			.filter((m): m is { id: string } => typeof m?.id === "string")
			.map((m) => ({ id: m.id }));
	} catch {
		return [];
	}
}

/**
 * Restart the sidecar for the given workspace so it picks up newly-configured
 * API keys. The facade caches its model registry on startup, so after writing
 * a new key to ~/.zharness/agent/auth.json the sidecar must be respawned for the
 * model list to refresh. No-op outside Tauri (web/preview builds don't have
 * a sidecar to restart).
 */
export async function restartSidecar(cwd: string): Promise<string> {
	if (!isTauri()) return "";
	// Tauri 2's `core.invoke` is generic; declaring `<string>` makes the
	// Rust command's `Result<String, String>` Ok variant flow through as
	// a real `string` instead of `void`. Without this the caller gets
	// `unknown` and `JSON.parse(undefined)` blows up.
	const core = await import("@tauri-apps/api/core");
	return await core.invoke<string>("restart_sidecar", { cwd });
}

// --- SSE implementation for browser mode ---

let sseSource: EventSource | null = null;
const sseHandlers = new Set<EventHandler>();
const responseWaiters = new Map<string, { command?: string; resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureSse() {
	if (sseSource) return;
	sseSource = new EventSource("/rpc/events");
	sseSource.onmessage = (ev) => {
		try {
			const line = JSON.parse(ev.data);
			if (line.type === "response") {
				// Try to match by id first
				if (line.id && responseWaiters.has(line.id)) {
					const waiter = responseWaiters.get(line.id)!;
					clearTimeout(waiter.timer);
					responseWaiters.delete(line.id);
					if (line.success) {
						waiter.resolve(line);
					} else {
						waiter.reject(new Error(line.error ?? "Command failed"));
					}
					return;
				}
				// Fallback: if no id match, resolve the oldest waiter
				// (zharness rpc may not echo back the id)
				const oldest = responseWaiters.entries().next();
				if (!oldest.done) {
					const [waiterId, waiter] = oldest.value;
					responseWaiters.delete(waiterId);
					clearTimeout(waiter.timer);
					if (line.success) {
						waiter.resolve(line);
					} else {
						waiter.reject(new Error(line.error ?? "Command failed"));
					}
					return;
				}
			}
			// Forward to all handlers (events + unmatched responses)
			for (const h of sseHandlers) {
				h(line);
			}
		} catch {
			// ignore non-JSON
		}
	};
	sseSource.onerror = () => {
		// Will auto-reconnect
	};
}

function subscribeSse(handler: EventHandler): () => void {
	ensureSse();
	sseHandlers.add(handler);
	return () => {
		sseHandlers.delete(handler);
	};
}

function waitForResponse<T>(id: string, timeoutMs: number, command?: string): Promise<RpcResponse<T>> {
	ensureSse();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			responseWaiters.delete(id);
			reject(new Error(`Command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		responseWaiters.set(id, { command, resolve: resolve as (r: RpcResponse) => void, reject, timer });
	});
}
