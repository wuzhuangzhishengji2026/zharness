/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: TypedEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { watch } from "node:fs";
import { join } from "node:path";
import { getMainDir } from "../../src/config.js";
import { buildPersonaData } from "../../src/core/main-agent.js";
import type { AgentMessage } from "../../src/core/agent/types.js";
import { computeMessageStats, type SessionStats } from "../../src/core/session-stats.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../src/core/extensions/index.js";
import { noOpUIContext } from "../../src/core/extensions/runner.js";
import type { EventBase, EventType, ImageContent as EventImageContent } from "../../src/core/event-store/types.js";
import { takeOverStdout, writeRawStdout } from "../../src/core/output-guard.js";
import type { SessionFacade } from "../../src/core/session-facade.js";
import { makeSessionRef, parseSessionRef } from "../../src/core/session-ref.js";
import { executeBashWithOperations } from "../../src/core/bash-executor.js";
import { createLocalBashOperations } from "../../src/core/tools/bash.js";
import {
	getBuiltinExtensionInfo,
	getBuiltinExtensionInfos,
	getBuiltinExtensionLifecycle,
} from "../../src/builtin-extensions/index.js";
import {
	isCodegenRunning,
	requestCodegenAbort,
	startCodegenPipeline,
} from "../../src/builtin-extensions/codegen-sma/index.js";
import { loadState } from "../../src/builtin-extensions/codegen-sma/state.js";
import { STAGE_ORDER } from "../../src/builtin-extensions/codegen-sma/stages.js";
import type { PipelineIO } from "../../src/builtin-extensions/codegen-sma/orchestrator.js";
import {
		SchedulerEngine,
		generateTaskId,
		isScopeEngineAlive,
		mutateTaskAnyScope,
	nextRunAt,
	readRuns,
	readTasks,
	readTasksAllScopes,
	readTasksChecked,
	readWorkspaceCwd,
	unsupportedSessionTargetReason,
	validateScheduleSpec,
	writeTasks,
	type Dispatcher,
	type SchedulerListener,
} from "../../src/core/scheduler/index.js";
import { exportFromFile } from "../../src/core/export-html/index.js";
import {
	getReplaySessionDir,
	listArtifactDir,
	listReplaySessions,
	loadReplaySummary,
	readArtifactFile,
} from "../../src/core/replay/index.js";
import {
	createTask,
	deleteTask,
	emitTaskBoardChanged,
	listTasks,
	updateTask,
} from "../../src/builtin-extensions/task-board/store.js";
import {
	clearAllMessageEdits,
	clearMessageEdit,
	clearSystemPromptOverride,
	getContextEditorSnapshot,
	isContextEditorLoaded,
	planSystemPromptForSend,
	setBaseBeforePersistent,
	setMessageEdit,
	setSystemPromptOverride,
	type ContextEditorSnapshot,
	type OverrideScope,
} from "../../src/builtin-extensions/context-editor/state.js";
import { toContextMessageView } from "../../src/builtin-extensions/context-editor/message-view.js";
import {
	cancelContextScore,
	computeContextFingerprint,
	getContextScoreStatus,
	startContextScore,
	type ContextScoreInput,
} from "../../src/builtin-extensions/context-editor/scorer.js";
import {
	buildKnowledgeDraft,
	saveKnowledge,
} from "../../src/builtin-extensions/proactive-assistant/knowledge.js";
import {
	clearSuggestions,
	dismissSuggestion,
	getMutedUntil,
	getSuggestion,
	getTotalToolStats,
	getUserTurns,
	hasOfferedKnowledge,
	isProactiveAssistantLoaded,
	listActiveSuggestions,
	markApplied,
	mute,
} from "../../src/builtin-extensions/proactive-assistant/store.js";
import { deriveWorkspaceId } from "../../src/core/event-store/workspace.js";
import {
	addCustomSkin,
	applySkin,
	findSkin,
	getSkinState,
	readSkinImage,
	removeCustomSkin,
	renameCustomSkin,
	toRpcSkin,
} from "../../src/builtin-extensions/skins/store.js";
import { emitSkinChanged } from "../../src/builtin-extensions/skins/index.js";
import {
	emitPetsChanged,
	hatchPet,
	getActivePetView,
	getPetsState,
	interactPet,
	releasePet,
	renamePet,
	setActivePet,
	toPetView,
} from "../../src/builtin-extensions/pets/store.js";
import { listAllSessionsLight } from "../../src/core/session-listing.js";
import { installSkillFromDirectory } from "../../src/core/skill-install.js";
import {
	installBuiltinSop,
	installSopFromGitHub,
	listBuiltinSops,
	uninstallSop,
} from "../../src/core/sop-install.js";
import { loadInstalledSops, type Sop } from "../../src/core/sop.js";
import type { HistoryTreeNodeInfo } from "../../src/core/projection/history-tree.js";
import { CONTEXT_RELEVANT_EVENT_TYPES } from "../../src/core/projection/session-projection.js";
import { eventToMessage } from "../../src/core/projection/event-to-message.js";
import { killTrackedDetachedChildren } from "../../src/utils/shell.js";
import { startPtyServer, type PtyServer } from "../pty/pty-server.js";
import { type Theme, theme } from "../../packages/tui/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcExtensionInfo,
	RpcSopInfo,
	RpcSopMarketEntry,
	RpcContextMessage,
	RpcContextOverridesSnapshot,
	RpcContextPreviewData,
	RpcContextTool,
} from "./rpc-types.js";
import type {
	ScheduledTask,
	ScheduledTaskSummary,
	SessionTarget,
} from "./rpc-types.js";
import { SCHEDULED_TASK_COMPLETED, SCHEDULED_TASK_FIRED } from "./rpc-types.js";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

function toEventImages(images?: unknown[]): EventImageContent[] | undefined {
	if (!images) return undefined;
	return images.map((image) => {
		const img = image as ImageContent & { mime_type?: string };
		return {
			type: "image",
			data: img.data,
			mime_type: img.mime_type ?? img.mimeType,
		};
	});
}

function getLastAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return null;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => {
			return typeof block === "object" && block !== null && "type" in block;
		})
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function getFacadeSessionEvents(facade: SessionFacade, types?: EventType[]): EventBase[] {
	const descriptor = facade.getProjection().getDescriptor();
	return facade.runtime.store.query({
		after: descriptor.event_range.start_event_id === "ORIGIN" ? undefined : descriptor.event_range.start_event_id,
		before: descriptor.event_range.end_event_id === "HEAD" ? undefined : descriptor.event_range.end_event_id,
		types,
	});
}

/**
 * Resolve the workspace id backing the task board. GUI sidecars always have a
 * projection; minimal/embedded sessions fall back to the cwd-derived id —
 * the same derivation the task-board extension uses, so all entry points
 * (RPC, agent tool, /taskboard command) share one task-board.json.
 */
function resolveTaskBoardWorkspaceId(facade: SessionFacade): string {
	try {
		const descriptor = facade.getProjection().getDescriptor();
		if (descriptor.workspace_id) return descriptor.workspace_id;
	} catch {
		// no projection in minimal sessions
	}
	return deriveWorkspaceId(facade.runtime.cwd ?? process.cwd());
}

/**
 * task_board 命令的工作区解析:命令显式携带 workspaceId 时优先使用
 * (GUI 首页看板固定读写主对话工作区,不随会话工作区切换)。
 * 仅接受 ws_<12hex> 格式,防路径穿越;否则退回当前会话工作区。
 */
function resolveCommandBoardWorkspaceId(command: { workspaceId?: unknown }, facade: SessionFacade): string {
	const id = command.workspaceId;
	if (typeof id === "string" && /^ws_[a-f0-9]{12}$/.test(id)) return id;
	return resolveTaskBoardWorkspaceId(facade);
}

/** context-editor 扩展快照 → 协议快照（字段重命名 + 可序列化）。 */
function toOverridesSnapshot(snapshot: ContextEditorSnapshot): RpcContextOverridesSnapshot {
	const out: RpcContextOverridesSnapshot = { extensionLoaded: snapshot.loaded, messageEdits: snapshot.messageEdits };
	if (snapshot.systemPromptOverride) out.systemPromptOverride = { ...snapshot.systemPromptOverride };
	if (snapshot.restoreBaseSystemPrompt !== undefined) out.restoreBaseSystemPrompt = snapshot.restoreBaseSystemPrompt;
	if (snapshot.baseBeforePersistent !== undefined) out.baseBeforePersistent = snapshot.baseBeforePersistent;
	return out;
}

function getFacadeForkMessages(facade: SessionFacade): Array<{ entryId: string; text: string }> {
	return getFacadeSessionEvents(facade, ["USER_MESSAGE"])
		.map((event) => {
			const payload = event.payload as { content?: unknown };
			return { entryId: event.event_id, text: extractMessageText(payload.content) };
		})
		.filter((message) => message.text.length > 0);
}

function getFacadeLeafEventId(facade: SessionFacade): string | undefined {
	const context = facade.getProjection().buildContext();
	return context.events.at(-1)?.event_id;
}

/** context_preview / context_score 共用：投影消息 → 预览视图（含覆盖预演）。 */
function buildContextMessageViews(facade: SessionFacade): RpcContextMessage[] {
	const built = facade.getProjection().buildContext();
	const snapshot = getContextEditorSnapshot();
	return built.messages.map((message, index) => {
		const eventId = built.sourceEventIds?.[index];
		const view = toContextMessageView(message, eventId) as unknown as RpcContextMessage;
		const edit = eventId ? snapshot.messageEdits[eventId] : undefined;
		if (edit && view.sentToLlm) {
			view.appliedEdit = { action: edit.action, scope: edit.scope };
			if (edit.action === "edit" && typeof edit.text === "string") {
				view.text = edit.text;
				view.charCount = edit.text.length;
			}
		}
		return view;
	});
}

/** 组装打分输入：与「应用并发送」真正到达模型的内容一致（已标记删除的消息剔除）。 */
function buildContextScoreInput(facade: SessionFacade, pendingUserMessage?: string): ContextScoreInput {
	const projection = facade.getProjection();
	const currentSystemPrompt = facade.systemPrompt;
	const planned = planSystemPromptForSend(currentSystemPrompt);
	return {
		sessionId: projection.getDescriptor().session_id,
		effectiveSystemPrompt: planned.result ?? currentSystemPrompt,
		toolNames: facade.tools.map((tool) => tool.name),
		messages: buildContextMessageViews(facade)
			.filter((view) => view.appliedEdit?.action !== "delete")
			.map((view) => ({
				eventId: view.eventId,
				kind: view.kind,
				role: view.role,
				text: view.text,
				charCount: view.charCount,
				sentToLlm: view.sentToLlm,
			})),
		draft: typeof pendingUserMessage === "string" && pendingUserMessage.length > 0 ? pendingUserMessage : undefined,
	};
}

function getFacadeSessionStats(facade: SessionFacade): SessionStats {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	return {
		...computeMessageStats(messages),
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
	};
}

/** Derive a display name + id from an extension path. Built-ins use their id. */
function extensionIdFromPath(extPath: string): string {
	const match = /^<builtin:([^>]+)>$/.exec(extPath);
	if (match) return match[1];
	const base = extPath.replace(/\.ts$/, "").replace(/\.js$/, "");
	const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
	return slash >= 0 ? base.slice(slash + 1) : base;
}

/** Map a loaded extension's sourceInfo/path to the RPC kind. */
function extensionKind(ext: {
	path: string;
	sourceInfo: { source: string; scope: string; origin: string };
}): RpcExtensionInfo["kind"] {
	if (/^<builtin:/.test(ext.path)) return "builtin";
	if (ext.sourceInfo.origin === "package") return "package";
	if (ext.sourceInfo.source === "cli") return "cli";
	if (ext.sourceInfo.scope === "project") return "project";
	return "user";
}

/** Map a loaded Sop to its `sop_list` RPC shape. */
function toRpcSopInfo(sop: Sop): RpcSopInfo {
	return {
		slug: sop.slug,
		name: sop.name,
		description: sop.description,
		version: sop.version,
		author: sop.author,
		tags: sop.tags,
		kind: sop.kind,
		args: sop.args.map((a) => ({ name: a.name, required: a.required === true })),
		stepCount: sop.steps.length,
		path: sop.filePath,
	};
}

/** Map a loaded Sop to its `sop_market` entry shape. */
function toRpcMarketEntry(sop: Sop, source: string): RpcSopMarketEntry {
	return {
		slug: sop.slug,
		name: sop.name,
		description: sop.description,
		version: sop.version,
		author: sop.author,
		tags: sop.tags,
		kind: sop.kind,
		stepCount: sop.steps.length,
		source,
		installed: false,
	};
}

/** Install a bundled SOP template, normalizing the result for the RPC response. */
function wrapBuiltinSopInstall(slug: string): { ok: boolean; message: string } {
	const target = installBuiltinSop(slug);
	if (!target) {
		return { ok: false, message: `Bundled SOP "${slug}" not found.` };
	}
	return { ok: true, message: `SOP "${slug}" installed to ${target}.` };
}

/**
 * Build the full extension list for the `get_extensions` RPC: every loaded
 * extension (enabled), plus any disabled built-ins (so the UI can show and
 * re-enable them).
 */
async function buildExtensionInfos(facade: SessionFacade): Promise<RpcExtensionInfo[]> {
	const infos: RpcExtensionInfo[] = [];
	const loadedIds = new Set<string>();
	const loaded = facade.resourceLoader?.getExtensions().extensions ?? [];
	const cwd = facade.runtime?.cwd ?? process.cwd();

	// Resolve install state (installed?) for every installable built-in up front,
	// concurrently. Best-effort: a failed check defaults to "not installed".
	const installState = new Map<string, { installed: boolean; version?: string }>();
	await Promise.all(
		getBuiltinExtensionInfos().map(async (info) => {
			const lc = getBuiltinExtensionLifecycle(info.id);
			if (!lc?.installable || !lc.checkInstalled) return;
			try {
				installState.set(info.id, await lc.checkInstalled(cwd));
			} catch {
				installState.set(info.id, { installed: false });
			}
		}),
	);

	const installableFor = (id: string): boolean => Boolean(getBuiltinExtensionLifecycle(id)?.installable);

	for (const ext of loaded) {
		const id = extensionIdFromPath(ext.path);
		loadedIds.add(id);
		const builtin = getBuiltinExtensionInfo(id);
		const installable = installableFor(id);
		infos.push({
			id,
			name: builtin?.name ?? id,
			description: builtin?.description,
			kind: extensionKind(ext),
			enabled: true,
			canToggle: Boolean(builtin),
			installable,
			installed: installable ? (installState.get(id)?.installed ?? false) : true,
			path: ext.path,
			toolCount: ext.tools.size,
			commandCount: ext.commands.size,
		});
	}

	// Built-ins that are not currently loaded. A built-in shows as disabled only
	// when the user has explicitly disabled it (settings.disabledBuiltinExtensions);
	// otherwise it is considered enabled even if this facade has no resource loader
	// (e.g. minimal/embedded sessions).
	const disabledBuiltins = facade.settingsManager.getDisabledBuiltinExtensions();
	for (const info of getBuiltinExtensionInfos()) {
		if (loadedIds.has(info.id)) continue;
		const installable = installableFor(info.id);
		infos.push({
			id: info.id,
			name: info.name,
			description: info.description,
			kind: "builtin",
			enabled: !disabledBuiltins.has(info.id),
			canToggle: true,
			installable,
			installed: installable ? (installState.get(info.id)?.installed ?? false) : true,
			path: `<builtin:${info.id}>`,
			toolCount: 0,
			commandCount: 0,
		});
	}
	// Stable ordering: built-ins first, then the rest by id.
	infos.sort((a, b) => {
		if ((a.kind === "builtin") !== (b.kind === "builtin")) {
			return a.kind === "builtin" ? -1 : 1;
		}
		return a.id.localeCompare(b.id);
	});
	return infos;
}

/**
 * Run an install/uninstall lifecycle action for a built-in extension.
 * Returns the action result plus a freshly-checked `installed` state so the
 * UI can update without a separate refetch.
 */
/**
 * Track in-flight install/uninstall operations per extension id to prevent
 * concurrent spawns (e.g. user clicks Install twice). Without this, multiple
 * `agent-browser install` processes can race on the same Chrome download lock
 * and one of them hangs indefinitely.
 */
const lifecycleInFlight = new Map<string, Promise<{ ok: boolean; message: string; installed: boolean }>>();

/** Serializes skill-directory installs (git clone + resource reload). */
let skillInstallInFlight = false;

/** Serializes SOP-market installs (git clone / bundled copy into <agentDir>/sops). */
let sopInstallInFlight = false;

async function runExtensionLifecycle(
	facade: SessionFacade,
	extensionId: string,
	action: "install" | "uninstall",
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const lc = getBuiltinExtensionLifecycle(extensionId);
	if (!lc?.installable) {
		return {
			ok: false,
			message: "This extension does not support install/uninstall.",
			installed: false,
		};
	}
	// Reject concurrent calls for the same extension id.
	const inFlight = lifecycleInFlight.get(extensionId);
	if (inFlight) {
		return {
			ok: false,
			message: `${action} already in progress for ${extensionId}.`,
			installed: false,
		};
	}
	const cwd = facade.runtime?.cwd ?? process.cwd();
	const fn = action === "install" ? lc.install : lc.uninstall;
	if (!fn) {
		return { ok: false, message: `No ${action} handler for ${extensionId}.`, installed: false };
	}
	const task = (async () => {
		try {
			const result = await fn(cwd);
			let installed = action === "install" ? result.ok : false;
			if (lc.checkInstalled) {
				try {
					installed = (await lc.checkInstalled(cwd)).installed;
				} catch {
					installed = action === "install" ? result.ok : false;
				}
			}
			return { ok: result.ok, message: result.message, installed };
		} finally {
			lifecycleInFlight.delete(extensionId);
		}
	})();
	lifecycleInFlight.set(extensionId, task);
	return task;
}


/** One-line preview of a message for history_tree view / diff. */
function formatMessagePreview(message: AgentMessage): string | undefined {
	const role = (message as { role?: string }).role ?? "message";
	const content = (message as { content?: unknown }).content;
	const text = extractMessageText(content).replace(/\s+/g, " ").trim();
	if (!text) {
		// Surface tool calls even when there's no text.
		const toolCalls = Array.isArray(content)
			? content.filter((b) => (b as { type?: string }).type === "toolCall").length
			: 0;
		if (toolCalls > 0) return `${role}: [${toolCalls} tool call${toolCalls === 1 ? "" : "s"}]`;
		return undefined;
	}
	const truncated = text.length > 140 ? `${text.slice(0, 140)}…` : text;
	return `${role}: ${truncated}`;
}

function resolveSessionId(facade: SessionFacade, ref: string): string {
	const parsed = parseSessionRef(ref);
	if (parsed.workspaceId && parsed.workspaceId !== facade.runtime.store.workspace_id) {
		throw new Error(`Session belongs to a different workspace: ${parsed.workspaceId}`);
	}
	return parsed.sessionId;
}

function getFacadeSessionState(facade: SessionFacade, ptyPort?: number): RpcSessionState {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	const resolvedModel = facade.modelRegistry?.find(facade.model.provider, facade.model.model_id);
	const contextWindow = (resolvedModel as { contextWindow?: number } | undefined)?.contextWindow ?? 0;

	// Context usage estimate — uses the last assistant usage when available,
	// falling back to a rough char/4 estimate for trailing messages.
	let contextUsage: RpcSessionState["contextUsage"];
	if (contextWindow > 0) {
		let tokens: number | null = null;
		// Find last assistant usage to get an accurate context token count.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { role?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string };
			if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
				const u = msg.usage;
				tokens = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				// Add rough estimate for any messages after the last usage.
				for (let j = i + 1; j < messages.length; j++) {
					tokens += estimateMessageTokens(messages[j] as AgentMessage);
				}
				break;
			}
		}
		if (tokens === null) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateMessageTokens(message as AgentMessage);
			}
			tokens = estimated;
		}
		contextUsage = {
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
		};
	}

	// Cumulative token usage across all assistant messages.
	let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
	for (const msg of messages) {
		const m = msg as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
		if (m.role === "assistant" && m.usage) {
			const u = m.usage;
			totalInput += u.input ?? 0;
			totalOutput += u.output ?? 0;
			totalCacheRead += u.cacheRead ?? 0;
			totalCacheWrite += u.cacheWrite ?? 0;
			totalCost += u.cost?.total ?? 0;
		}
	}
	const tokenUsage = { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost };

	return {
		model: resolvedModel,
		thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
		isStreaming: facade.isRunning,
		isCompacting: false,
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
		autoCompactionEnabled: facade.settingsManager.getCompactionEnabled(),
		messageCount: messages.length,
		pendingMessageCount: 0,
		safeMode: facade.runtime.isSafeMode,
		ptyPort,
		contextUsage,
		tokenUsage,
	};
}

/** Rough token estimate for a message (chars / 4). Used when no usage data is available. */
function estimateMessageTokens(msg: AgentMessage): number {
	const content = "content" in msg ? (msg as { content?: unknown }).content : undefined;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((c) => (c as { type?: string }).type === "text").map((c) => (c as { text?: string }).text ?? "").join("")
			: "";
	return Math.ceil(text.length / 4);
}

/**
 * Run RPC mode against the event-sourced facade.
 * Events are emitted as raw EventStore TypedEvent JSON lines.
 */
export async function runRpcModeWithFacade(facade: SessionFacade): Promise<never> {
	takeOverStdout();
	let unsubscribe: (() => void) | undefined;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let ptyServer: PtyServer | undefined;
	// Start the local PTY-over-WebSocket server for the Terminal pane. We await
	// only the socket bind (fast, never blocks on node-pty, which loads lazily
	// per connection) so `ptyPort` is ready before the first get_state. Any
	// failure is non-fatal — ptyPort stays undefined and the pane degrades.
	try {
		ptyServer = await startPtyServer({ cwd: process.cwd() });
	} catch { /* PTY server unavailable; terminal pane degrades */ }

	// ---- File-tree live refresh ------------------------------------------
	// Watch the workspace root and emit debounced FS_CHANGED events so the GUI
	// file explorer refreshes without manual reload. Noisy/generated subtrees
	// are filtered before the debounce. Not part of the event store (a pure
	// transport-level notification); failure is non-fatal and the explorer
	// falls back to its manual refresh button.
	const FS_WATCH_IGNORED_TOP = new Set([
		".git", "node_modules", "dist", "target", "build", "out",
		".codegen", ".zharness", "__pycache__", ".venv", "venv",
	]);
	const FS_EVENT_DEBOUNCE_MS = 500;
	let fsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const fsWatcher = watch(process.cwd(), { recursive: true }, (_eventType, filename) => {
			const top = String(filename ?? "").split(/[\\/]/)[0];
			if (top && FS_WATCH_IGNORED_TOP.has(top)) return;
			if (fsRefreshTimer) clearTimeout(fsRefreshTimer);
			fsRefreshTimer = setTimeout(() => {
				fsRefreshTimer = undefined;
				output({ type: "FS_CHANGED" });
			}, FS_EVENT_DEBOUNCE_MS);
		});
		signalCleanupHandlers.push(() => {
			if (fsRefreshTimer) clearTimeout(fsRefreshTimer);
			fsWatcher.close();
		});
	} catch { /* recursive watch unavailable; file tree stays manual-refresh */ }

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	// Bridge extension command UI hooks into the event stream. Slash commands
	// dispatched through facade.prompt() (e.g. "/codegen status" from the GUI)
	// surface their output via notify → CUSTOM_MESSAGE event, which the
	// subscription below forwards to the client like any other event.
	//
	// Interactive dialogs (confirm/input) are bridged over the protocol:
	// emit an extension_ui_request line and wait for the matching
	// extension_ui_response on stdin. Clients that don't implement dialogs
	// (headless embedders) simply never respond — after the timeout we fall
	// back to auto-approve/auto-undefined with a visible notify, matching the
	// old headless behavior instead of hanging forever.
	type PendingUIRequest = { resolve: (value: RpcExtensionUIResponse) => void };
	const pendingUIRequests = new Map<string, PendingUIRequest>();
	let uiRequestSeq = 0;
	const EXTENSION_UI_TIMEOUT_MS = 300_000;

	const notifyBridge = (message: string, type?: "info" | "warning" | "error"): void => {
		facade.runtime.store.append({
			actor_id: "runtime",
			type: "CUSTOM_MESSAGE",
			payload: {
				extension_id: "extension",
				kind: type ?? "info",
				data: message,
				display: true,
			},
		});
	};

	const requestUIDialog = <T>(
		request: { method: "confirm" | "input"; title: string; message?: string; placeholder?: string },
		fallback: T,
		adapt: (response: RpcExtensionUIResponse) => T,
		fallbackNotice: string,
	): Promise<T> => {
		const id = `ui_req_${++uiRequestSeq}`;
		return new Promise<T>((resolve) => {
			const timer = setTimeout(() => {
				pendingUIRequests.delete(id);
				notifyBridge(fallbackNotice, "warning");
				resolve(fallback);
			}, EXTENSION_UI_TIMEOUT_MS);
			pendingUIRequests.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(adapt(value));
				},
			});
			output({ type: "extension_ui_request", id, ...request, timeout: EXTENSION_UI_TIMEOUT_MS } as RpcExtensionUIRequest);
		});
	};

	const extensionRunner = facade.extensionRunner;
	if (extensionRunner) {
		extensionRunner.setUIContext({
			...noOpUIContext,
			notify: (message, type) => notifyBridge(message, type),
			confirm: (title, message) =>
			requestUIDialog<boolean>(
				{ method: "confirm", title, message },
				true,
				(response) => (response as { confirmed?: boolean }).confirmed === true,
				`【${title}】${EXTENSION_UI_TIMEOUT_MS / 1000} 秒内未收到界面响应，确认点已自动通过（headless 客户端行为）`,
			),
		input: (title, placeholder) =>
			requestUIDialog<string | undefined>(
				{ method: "input", title, placeholder },
				undefined,
				(response) => {
					const r = response as { cancelled?: boolean; value?: string };
					return r.cancelled ? undefined : r.value;
				},
				`【${title}】${EXTENSION_UI_TIMEOUT_MS / 1000} 秒内未收到界面响应，输入已按取消处理（headless 客户端行为）`,
			),
		});
	}

	// ---- Scheduled task engines (定时任务, 移植自 zharness 融合版) ----
	// 每个 scope 一个引擎;dispatcher 绑定本 sidecar 的 facade(prompt 只能
	// 发给本进程的 agent),所以每个 sidecar 只调度自己能服务的 scope:
	//   - main sidecar(--main, cwd=~/.zharness/main)→ main scope
	//   - 项目 sidecar → 自己的工作区 scope
	// 其他工作区的任务由该工作区的 sidecar 打开时接管(engine.load + 触发前
	// readTaskFresh);GUI 的 CRUD 走 store 层,对任意 scope 都可写。
	// 跨进程 scope 锁保证多窗口并存时不重复触发。
	const schedulerEngines = new Map<string, SchedulerEngine>();
	const schedulerDispatcher: Dispatcher = {
		dispatch: async (task) => {
			try {
				const target = task.sessionTarget;
				const sessionManager = facade.runtime.sessionManager;
				const previousActiveSessionId = sessionManager?.getActiveSessionId();
				let promptSessionId: string | undefined;
				let restorePrevious = false;

				if (!target || target.kind === "current") {
					promptSessionId = previousActiveSessionId;
				} else if (target.kind === "pinned") {
					// pinned 无 sessionId(跨 scope 直写创建的老数据/兜底数据)时
					// 落到当前活跃会话——比直接报错友好:立即运行总能触发。
					if (!target.sessionId) {
						promptSessionId = previousActiveSessionId;
						if (!promptSessionId) {
							return { error: "pinned session target is missing sessionId and no active session to fall back to" };
						}
					} else {
						if (!sessionManager) {
							return { error: "sessionManager unavailable; cannot switch to pinned session" };
						}
						promptSessionId = target.sessionId;
						if (promptSessionId !== previousActiveSessionId) {
							try {
								sessionManager.switchTo(promptSessionId);
								restorePrevious = true;
							} catch (e) {
								return { error: `switch pinned session failed: ${e instanceof Error ? e.message : String(e)}` };
							}
						}
					}
				} else if (target.kind === "new") {
					if (!sessionManager) {
						return { error: "sessionManager unavailable; cannot create new session" };
					}
						try {
							// Fresh session in its OWN thread — scheduled runs must not
							// interleave into the user's conversation; do NOT close the
							// user's active session (closeActive: false).
							sessionManager.createThread(`scheduled: ${target.purpose || task.name}`, {
								closeActive: false,
							});
							promptSessionId = sessionManager.getActiveSessionId();
							restorePrevious = true;
						} catch (e) {
							return { error: `createThread failed: ${e instanceof Error ? e.message : String(e)}` };
						}
				}

				// Subscribe BEFORE the prompt so we capture the exact event id
				// of the USER_MESSAGE this task produced (not a user's own).
				const beforeSequence = facade.runtime.store.head_sequence;
				let dispatchedUserMessageId: string | undefined;
				const unsub = facade.subscribe((event) => {
					if (event.type === "USER_MESSAGE" && event.sequence > beforeSequence) {
						const payload = event.payload as { content?: unknown };
						if (extractMessageText(payload.content) === task.prompt) {
							dispatchedUserMessageId = event.event_id;
						}
					}
				});
				try {
					await facade.prompt(task.prompt);
				} finally {
					unsub();
					if (restorePrevious && sessionManager) {
						// 派发用的新/pinned 会话封口在自己的线程里:它的见证范围到
						// 派发结束为止,否则悬挂 open 区间会一直吞到当前(重启时由
						// 加载兜底再修一次)。
						const dispatched = promptSessionId ? sessionManager.getSession(promptSessionId) : undefined;
						if (dispatched && dispatched.event_range.end_event_id === "HEAD") {
							dispatched.event_range.end_event_id =
								facade.runtime.store.head ?? dispatched.event_range.start_event_id;
						}
						// 恢复调度前的活跃会话。临时 "scheduled: X" 会话绝不能留在
						// 活跃位——否则它会变成 GUI 的「当前对话」,后续 pinned 任务
						// 也会错误锚定到它,导致定时任务卡片在用户真实对话里不显示、
						// 只在任务触发瞬间随会话跳转出现。
						const prevExists = previousActiveSessionId
							? Boolean(sessionManager.getSession(previousActiveSessionId))
							: false;
						if (prevExists && previousActiveSessionId) {
							try {
								sessionManager.switchTo(previousActiveSessionId);
							} catch {
								/* The previous session may have been removed; ignore. */
							}
						} else {
							// 调度前没有活跃会话(或已被删除):回退到最近一个非本次
							// 创建的会话,避免活跃位漂移到临时 scheduled 会话。
							const fallback = sessionManager
								.listSessions()
								.find((s) => s.session_id !== promptSessionId);
							if (fallback) {
								try {
									sessionManager.switchTo(fallback.session_id);
								} catch {
									/* ignore */
								}
							}
						}
					}
				}
				return { eventId: dispatchedUserMessageId, sessionId: promptSessionId };
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e) };
			}
		},
		abort: (_taskId: string): void => {
			// Best-effort abort: facade.abort() drops the in-flight turn. The
			// engine handles the post-abort bookkeeping (run record, lock release).
			try {
				facade.abort();
			} catch {
				/* ignore */
			}
		},
	};
	const buildSchedulerListener = (scope: "main" | "workspace", workspaceId: string | undefined): SchedulerListener =>
		(event): void => {
			if (event.type === "task.fired") {
				const p = event.payload as { taskId: string; at: number; sessionId?: string };
				output({
					type: SCHEDULED_TASK_FIRED,
					event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					payload: { taskId: p.taskId, at: p.at, sessionId: p.sessionId, scope, workspaceId },
				});
			} else if (event.type === "task.completed") {
				output({
					type: SCHEDULED_TASK_COMPLETED,
					event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					payload: event.payload,
				});
			}
		};
	const startSchedulerEngine = (scope: "main" | "workspace", workspaceId?: string): void => {
		const key = scope === "main" ? "main" : `ws:${workspaceId ?? ""}`;
		if (schedulerEngines.has(key)) return;
		try {
			const engine = new SchedulerEngine({
				scope,
				workspaceId,
				dispatcher: schedulerDispatcher,
				listener: buildSchedulerListener(scope, workspaceId),
			});
			engine.load();
			schedulerEngines.set(key, engine);
		} catch (e) {
			console.warn(`[scheduler] failed to start engine for ${key}: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	try {
		const isMainSidecar = process.argv.includes("--main");
		if (isMainSidecar) {
			startSchedulerEngine("main");
			// 安全网:主对话目录同时也是普通工作区(ws_<hash>)。历史上一个
			// 不带 --main 的 sidecar 曾把主对话目录按 workspace scope 落过
			// 任务;main sidecar 同时服务该 scope,这些任务不再无人接管。
			const descriptorWorkspaceId = facade.getProjection().getDescriptor().workspace_id;
			if (descriptorWorkspaceId) startSchedulerEngine("workspace", descriptorWorkspaceId);
		} else {
			const descriptorWorkspaceId = facade.getProjection().getDescriptor().workspace_id;
			if (descriptorWorkspaceId) startSchedulerEngine("workspace", descriptorWorkspaceId);
		}
	} catch (e) {
		console.warn(`[scheduler] engine startup failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	/** 找到本进程内服务某 scope 的引擎(main 或指定工作区)。 */
	const engineFor = (scope: "main" | "workspace", workspaceId?: string): SchedulerEngine | undefined =>
		schedulerEngines.get(scope === "main" ? "main" : `ws:${workspaceId ?? ""}`);
	/** Pinned 无 sessionId(或 legacy current)时回填当前活跃会话。 */
	const fillPinnedSessionTarget = (target: SessionTarget | undefined): SessionTarget | undefined => {
		const activeSessionId = facade.runtime.sessionManager?.getActiveSessionId();
		if (!target || target.kind === "current") {
			return activeSessionId ? { kind: "pinned", sessionId: activeSessionId } : { kind: "pinned" };
		}
		if (target.kind !== "pinned" || target.sessionId) return target;
		return activeSessionId ? { ...target, sessionId: activeSessionId } : target;
	};
	const summaryFor = (task: ScheduledTask): ScheduledTaskSummary => ({
		...task,
		nextRunAt: task.enabled ? nextRunAt(task) : null,
		workspaceCwd:
			task.scope === "workspace" && task.workspaceId ? readWorkspaceCwd(task.workspaceId) : undefined,
	});

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};
	const waitForCompactionEnd = (): Promise<{ summary: string; first_kept_event_id: string; tokens_before: number }> => {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error("Compaction timed out"));
			}, 30000);
			const unsub = facade.subscribe((event) => {
				if (event.type === "COMPACTION_END") {
					clearTimeout(timer);
					unsub();
					resolve(event.payload as { summary: string; first_kept_event_id: string; tokens_before: number });
				}
			});
			facade.compact({ reason: "manual" });
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		for (const engine of schedulerEngines.values()) {
			try {
				engine.dispose();
			} catch { /* best-effort */ }
		}
		unsubscribe?.();
		await Promise.resolve(facade.dispose());
		await ptyServer?.close().catch(() => {});
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			case "prompt":
				void facade.prompt(command.message, toEventImages(command.images)).catch((e: unknown) => {
					output(error(id, "prompt", e instanceof Error ? e.message : String(e)));
				});
				return success(id, "prompt");

			case "steer":
				facade.steer(command.message, toEventImages(command.images));
				return success(id, "steer");

			case "follow_up": {
				// The GUI picks follow_up whenever its local isStreaming flag says
				// a turn is live — but that flag can be stale (missed turn-completed
				// event, sidecar restart). A queued follow-up with no live turn is
				// undeliverable: the drain point only runs inside a prompt cycle,
				// so the message would sit in the store and the user would see
				// nothing ("sent, but no reply"). Route it through prompt() when
				// no turn is actually running; queueing for the NEXT prompt stays
				// available to callers that await prompt() afterwards (TUI/tests).
				if (facade.isRunning) {
					facade.followUp(command.message, toEventImages(command.images));
				} else {
					void facade.prompt(command.message, toEventImages(command.images)).catch((e: unknown) => {
						output(error(id, "follow_up", e instanceof Error ? e.message : String(e)));
					});
				}
				return success(id, "follow_up");
			}

			case "abort":
				facade.abort();
				return success(id, "abort");

			case "get_state":
				return success(id, "get_state", getFacadeSessionState(facade, ptyServer?.port));

			case "set_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				facade.setModel(model);
				return success(id, "set_model", model);
			}

			case "get_available_models": {
				// Return ALL models, annotated with hasAuth so the UI can show
				// unconfigured models as disabled rather than hiding them.
				const registry = facade.modelRegistry;
				const all = registry?.getAll() ?? [];
				// Providers the user explicitly added via models.json — the
				// picker keeps their models visible (disabled) even without a
				// key, instead of hiding them like unconfigured catalog ones.
				const customProviders = registry?.getModelsJsonProviders() ?? new Set<string>();
				const models = all.map((m) => ({
					id: m.id,
					name: m.name,
					api: m.api,
					provider: m.provider,
					reasoning: (m as { reasoning?: boolean }).reasoning,
					contextWindow: (m as { contextWindow?: number }).contextWindow,
					hasAuth: registry ? registry.hasConfiguredAuth(m) : true,
					custom: customProviders.has(m.provider),
				}));
				// Surface skipped/failed custom providers (models.json issues)
				// so the GUI can explain an empty picker instead of looking
				// broken while valid providers were silently dropped.
				return success(id, "get_available_models", { models, loadError: registry?.getError() ?? undefined });
			}

			case "cycle_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				if (models.length === 0) {
					return success(id, "cycle_model", null);
				}
				const current = facade.model;
				const currentIndex = models.findIndex(
					(model) => model.provider === current.provider && model.id === current.model_id,
				);
				if (models.length === 1 && currentIndex === 0) {
					return success(id, "cycle_model", null);
				}
				const model = models[(currentIndex + 1) % models.length] ?? models[0]!;
				facade.setModel(model);
				return success(id, "cycle_model", {
					model,
					thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
					isScoped: false,
				});
			}

			case "set_thinking_level":
				facade.thinkingLevel = command.level;
				return success(id, "set_thinking_level");

			case "cycle_thinking_level": {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
				const current = facade.thinkingLevel ?? "off";
				const index = levels.findIndex((level) => level === current);
				const level = levels[(index + 1) % levels.length] ?? "off";
				facade.thinkingLevel = level;
				return success(id, "cycle_thinking_level", { level });
			}

			case "compact": {
				const result = await waitForCompactionEnd();
				return success(id, "compact", {
					summary: result.summary,
					firstKeptEntryId: result.first_kept_event_id,
					tokensBefore: result.tokens_before,
				});
			}

			case "get_messages": {
				// 带 sessionId:该分支投影(继承段 ∪ 主段)的上下文消息(只读,
				// 不改变活跃位)。侧栏点击旧行的「查看模式」走这里 —— 分支是
				// 视图单位:rewind 掉的旧尾巴和同线程其它分支的内容不会串进
				// 来;branchSummary 与投影明细重复,滤掉。
				if (command.sessionId) {
					const sessionManager = facade.runtime.sessionManager;
					const projection = sessionManager?.getSessionProjection(command.sessionId);
					if (!sessionManager || !projection) {
						return error(id, "get_messages", `Session not found: ${command.sessionId}`);
					}
					const events = projection.getSessionEvents(CONTEXT_RELEVANT_EVENT_TYPES);
					const messages: unknown[] = [];
					for (const event of events) {
						const message = eventToMessage(event);
						if (!message) continue;
						if ((message as { role?: string }).role === "branchSummary") continue;
						messages.push(message);
					}
					return success(id, "get_messages", { messages, sessionId: command.sessionId });
				}
				return success(id, "get_messages", { messages: facade.getProjection().buildContext().messages });
			}

			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", {
					text: getLastAssistantText(facade.getProjection().buildContext().messages),
				});

			case "rewind": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "rewind", "Projection session manager is not available");
				}
				if (command.targetEventId) {
					const event = facade.runtime.store.get(command.targetEventId);
					if (!event) {
						return error(id, "rewind", `Event not found: ${command.targetEventId}`);
					}
					sessionManager.forkAt(command.targetEventId);
				}
				// No target: no-op, eternal conversation auto-continues
				const desc = facade.getProjection().getDescriptor();
				return success(id, "rewind", { cancelled: false, sessionId: desc.session_id });
			}

			case "switch_session": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "switch_session", "Projection session manager is not available");
				}
				sessionManager.switchTo(resolveSessionId(facade, command.sessionPath));
				return success(id, "switch_session", { cancelled: false });
			}

			case "fork": {
				const event = facade.runtime.store.get(command.entryId);
				if (!event) {
					return error(id, "fork", `Event not found: ${command.entryId}`);
				}
				facade.runtime.fork(command.entryId);
				return success(id, "fork", {
					text: event.type === "USER_MESSAGE" ? extractMessageText((event.payload as { content?: unknown }).content) : "",
					cancelled: false,
				});
			}

			case "clone": {
				const leafId = getFacadeLeafEventId(facade);
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				facade.runtime.fork(leafId);
				return success(id, "clone", { cancelled: false });
			}

			case "get_fork_messages":
				return success(id, "get_fork_messages", { messages: getFacadeForkMessages(facade) });

			case "get_session_stats":
				return success(id, "get_session_stats", getFacadeSessionStats(facade));

			case "set_auto_compaction":
				facade.settingsManager.setCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");

			case "get_commands": {
				const commands: RpcSlashCommand[] =
					facade.extensionRunner?.getRegisteredCommands().map((command) => ({
						name: command.invocationName,
						description: command.description,
						source: "extension" as const,
						sourceInfo: command.sourceInfo,
					})) ?? [];
				return success(id, "get_commands", { commands });
			}

			case "history_tree": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "history_tree", "Projection session manager is not available");
				}
				const store = facade.runtime.store;
				switch (command.action) {
					case "list": {
						// 谱系树来自每会话 header 的 parent/forkAt 指针（每会话一库
						// 后无共享日志可查）。默认活跃谱系；GUI 查看历史对话时带
						// sessionId 按目标谱系取 —— 分支树与对话页看同一棵树。
						let nodes = sessionManager.files.buildLineageNodes(command.sessionId);
						if (command.query) {
							const q = command.query.toLowerCase();
							nodes = nodes.filter(
								(n) =>
									n.name?.toLowerCase().includes(q) ||
									n.snippet?.toLowerCase().includes(q) ||
									n.session_id.toLowerCase().includes(q),
							);
						}
						return success(id, "history_tree", { action: "list", nodes });
					}
					case "view": {
						const projection = sessionManager.getSessionProjection(command.sessionId);
						if (!projection) {
							return success(id, "history_tree", { action: "view", view: null });
						}
						const descriptor = projection.getDescriptor();
						const previews = projection
							.buildContext()
							.messages.map((m) => formatMessagePreview(m))
							.filter((line): line is string => line !== undefined);
						const maxMessages = command.maxMessages ?? 40;
						return success(id, "history_tree", {
							action: "view",
							view: {
								session_id: descriptor.session_id,
								name: descriptor.name,
								messages: previews.slice(-maxMessages),
								message_count: previews.length,
							},
						});
					}
					case "jump": {
						const result = sessionManager.jumpToSession(command.sessionId, command.reason);
						return success(id, "history_tree", {
							action: "jump",
							session_id: result.descriptor.session_id,
							reopened: result.reopened,
						});
					}
					case "fork": {
						const desc = sessionManager.forkFromSession(command.sessionId, { preserveHistory: false });
						return success(id, "history_tree", { action: "fork", session_id: desc.session_id });
					}
					case "rename": {
						sessionManager.renameSession(command.sessionId, command.name);
						return success(id, "history_tree", { action: "rename", ok: true });
					}
					default: {
						const unknown = command as { action?: string };
						return error(id, "history_tree", `Unknown history_tree action: ${unknown.action}`);
					}
				}
			}

			case "get_events": {
				const store = facade.runtime.store;
				const eventTypes = command.eventTypes as EventType[] | undefined;
				const sinceSequence = command.sinceSequence;
				let events: EventBase[];
				if (command.sessionId) {
					// 查看模式:该分支投影(继承段 ∪ 主段)的事件(与 get_messages
					// 的 sessionId 分支同一投影规则)。
					const sessionManager = facade.runtime.sessionManager;
					const projection = sessionManager?.getSessionProjection(command.sessionId);
					if (!sessionManager || !projection) {
						return error(id, "get_events", `Session not found: ${command.sessionId}`);
					}
					events = projection.getSessionEvents(eventTypes);
				} else if (command.sessionScoped) {
					events = getFacadeSessionEvents(facade, eventTypes);
				} else {
					events = store.query({ types: eventTypes });
				}
				if (typeof sinceSequence === "number") {
					// Incremental sync cursor for serve-mode mobile clients.
					events = events.filter((e) => e.sequence > sinceSequence);
				}
				const limit = command.limit ?? 1000;
				const sliced = events.length > limit ? events.slice(-limit) : events;
				return success(id, "get_events", {
					events: sliced.map((e) => ({
						event_id: e.event_id,
						type: e.type,
						timestamp: e.timestamp,
						sequence: e.sequence,
						actor_id: e.actor_id,
						caused_by: e.caused_by,
						thread_id: e.thread_id,
						payload: e.payload,
					})),
				});
			}

			case "list_sessions": {
				// 跨工作区轻量枚举(索引 + 每会话 ≤3 行 USER_MESSAGE 探测),
				// 供 GUI 侧栏把历史会话映射到所属项目(含主会话)。
				const sessions = listAllSessionsLight();
				return success(id, "list_sessions", { sessions });
			}

			case "codegen": {
				const cwd = facade.runtime?.cwd ?? process.cwd();
				const state = loadState(cwd);
				const withStageOrder = () => {
					const fresh = loadState(cwd);
					return fresh ? { ...fresh, stageOrder: STAGE_ORDER } : null;
				};
				// GUI 面板的流水线 IO:进度通知走聊天事件流,且每次通知附带最新
				// 状态快照(CODEGEN_STATE 事件驱动 RightDock 面板实时刷新);
				// 阶段确认点(需求/设计产物确认)走 extension_ui_request 对话框桥。
				const emitCodegenState = () => {
					const fresh = withStageOrder();
					if (fresh) output({ type: "CODEGEN_STATE", state: fresh });
				};
				const panelIO: PipelineIO = {
					notify: (message, type) => {
						notifyBridge(message, type);
						emitCodegenState();
					},
					confirm: (title, message) =>
						requestUIDialog<boolean>(
							{ method: "confirm", title, message },
							true,
							(response) => (response as { confirmed?: boolean }).confirmed === true,
							`【${title}】${EXTENSION_UI_TIMEOUT_MS / 1000} 秒内未收到界面响应，确认点已自动通过`,
						),
					input: (title, placeholder) =>
						requestUIDialog<string | undefined>(
							{ method: "input", title, placeholder },
							undefined,
							(response) => {
								const r = response as { cancelled?: boolean; value?: string };
								return r.cancelled ? undefined : r.value;
							},
							`【${title}】${EXTENSION_UI_TIMEOUT_MS / 1000} 秒内未收到界面响应，输入已按取消处理`,
						),
				};
				switch (command.action) {
					case "status":
						return success(id, "codegen", { state: withStageOrder(), running: isCodegenRunning() });
					case "start": {
						const goal = (command.goal ?? "").trim();
						if (!goal) return error(id, "codegen", "goal is required");
						const started = startCodegenPipeline(goal, cwd, panelIO);
						if (!started.ok) return error(id, "codegen", started.message);
						notifyBridge(started.message, "info");
						return success(id, "codegen", { state: withStageOrder(), running: true });
					}
					case "resume": {
						if (!state) return error(id, "codegen", "No pipeline state to resume");
						if (state.outcome === "completed") return error(id, "codegen", "Pipeline already completed");
						const started = startCodegenPipeline(state.goal, cwd, panelIO, state);
						if (!started.ok) return error(id, "codegen", started.message);
						notifyBridge(started.message, "info");
						return success(id, "codegen", { state: withStageOrder(), running: true });
					}
					case "abort": {
						requestCodegenAbort();
						return success(id, "codegen", { state: withStageOrder(), running: isCodegenRunning() });
					}
					default:
						return error(id, "codegen", `Unknown codegen action: ${String((command as { action?: string }).action)}`);
				}
			}

			case "get_scheduler_policy":
				return success(id, "get_scheduler_policy", { policy: facade.settingsManager.getSchedulerPolicy() });

			case "set_scheduler_policy": {
				facade.settingsManager.setSchedulerPolicy(command.policy);
				return success(id, "set_scheduler_policy", { policy: facade.settingsManager.getSchedulerPolicy() });
			}

			case "schedule_list": {
				// 全 scope 只读列表(main + 所有工作区)——GUI 列表页直接消费。
				const tasks = readTasksAllScopes().map(({ task }) => summaryFor(task));
				tasks.sort((a, b) => b.updatedAt - a.updatedAt);
				return success(id, "schedule_list", { tasks });
			}

			case "schedule_create": {
				const t = command.task;
				if (t.scope === "workspace" && !t.workspaceId) {
					return error(id, "schedule_create", "workspaceId is required for workspace scope");
				}
				const policy = facade.settingsManager.getSchedulerPolicy();
				const engine = engineFor(t.scope, t.workspaceId);
				if (engine) {
					const r = engine.create({
						name: t.name,
						prompt: t.prompt,
						schedule: t.schedule,
						enabled: t.enabled,
						description: t.description,
						createdBy: t.createdBy ?? "user",
						sourceText: t.sourceText,
						startAt: t.startAt,
						endAt: t.endAt,
						sessionTarget: fillPinnedSessionTarget(t.sessionTarget ?? policy.defaultSessionTarget),
						concurrencyPolicy: t.concurrencyPolicy ?? policy.concurrency,
						timeoutMinutes: t.timeoutMinutes ?? policy.timeoutMinutes,
					});
					if (!r.ok) return error(id, "schedule_create", r.error);
					return success(id, "schedule_create", { task: { ...r.task, workspaceCwd: t.scope === "workspace" && t.workspaceId ? readWorkspaceCwd(t.workspaceId) : undefined } });
				}
			// 本进程不服务该 scope(任务属于别的项目窗口):直接落盘。
			// 该工作区的 sidecar 未运行时,打开后 engine.load() 接管调度;
			// 已在运行时,其引擎的 tasks.json 监听(syncFromDisk)会发现
			// 这次写入并立即接管调度——不会像旧版那样静默不执行。
			// sessionTarget 不在这里回填 pinned 会话 id——本进程的活跃会话
			// 属于别的工作区,回填会导致运行侧跨库 switchTo 失败;保持
			// {kind:"pinned"} 无 id,运行侧 dispatch 兜底到当时的活跃会话,
			// 引擎在首次派发后把 pin 固化到该会话。
			// schedule 校验与 engine.create 同一标准——坏数据落盘会让拥有
			// 该 scope 的 sidecar 在 load/list 时解析失败。
			const validation = validateScheduleSpec(t.schedule);
			if (validation) return error(id, "schedule_create", validation);
			const now = Date.now();
			const task: ScheduledTask = {
				id: generateTaskId(),
				name: t.name.trim() || t.prompt.slice(0, 30),
				prompt: t.prompt,
				scope: t.scope,
				workspaceId: t.workspaceId,
				schedule: { ...t.schedule, startAt: t.startAt ?? t.schedule.startAt, endAt: t.endAt ?? t.schedule.endAt },
				enabled: t.enabled ?? true,
				description: t.description,
				createdAt: now,
				updatedAt: now,
				createdBy: t.createdBy ?? "user",
				sourceText: t.sourceText,
				runCount: 0,
				sessionTarget: t.sessionTarget ?? policy.defaultSessionTarget,
				concurrencyPolicy: t.concurrencyPolicy ?? policy.concurrency,
				timeoutMinutes: t.timeoutMinutes ?? policy.timeoutMinutes,
			};
			// tasks.json 读不了(损坏/被锁)时拒绝写入——把现有任务全部抹掉
			// 比拒绝一次创建严重得多。
			const disk = readTasksChecked(t.scope, t.workspaceId);
			if (!disk.ok) {
				return error(id, "schedule_create", "tasks.json is temporarily unreadable; try again later");
			}
			writeTasks(t.scope, t.workspaceId, [...disk.tasks, task]);
			return success(id, "schedule_create", { task: summaryFor(task) });
			}

			case "schedule_update": {
				const patch = command.patch;
				// 跨 scope 落盘路径绕过 engine.update,这里补上同一标准的
				// schedule 校验(坏 schedule 会让拥有方 load/list 解析失败)。
				if (patch.schedule) {
					const validation = validateScheduleSpec(patch.schedule);
					if (validation) return error(id, "schedule_update", validation);
				}
				const engine = engineFor(command.scope, command.workspaceId);
				if (engine) {
					const r = engine.update(command.taskId, {
						...patch,
						sessionTarget: patch.sessionTarget ? fillPinnedSessionTarget(patch.sessionTarget) : patch.sessionTarget,
					});
					if (!r.ok) return error(id, "schedule_update", r.error);
					return success(id, "schedule_update", { task: { ...r.task, workspaceCwd: command.scope === "workspace" && command.workspaceId ? readWorkspaceCwd(command.workspaceId) : undefined } });
				}
				const result = mutateTaskAnyScope(command.taskId, (task) => {
					const next: ScheduledTask = { ...task, updatedAt: Date.now() };
					if (patch.name !== undefined) next.name = patch.name;
					if (patch.prompt !== undefined) next.prompt = patch.prompt;
					if (patch.description !== undefined) {
						if (patch.description === null) delete next.description;
						else next.description = patch.description;
					}
					if (patch.enabled !== undefined) next.enabled = patch.enabled;
					if (patch.schedule !== undefined) next.schedule = patch.schedule;
					if (patch.startAt !== undefined) {
						if (patch.startAt === null) delete next.schedule.startAt;
						else next.schedule.startAt = patch.startAt;
					}
					if (patch.endAt !== undefined) {
						if (patch.endAt === null) delete next.schedule.endAt;
						else next.schedule.endAt = patch.endAt;
					}
					if (patch.sessionTarget !== undefined) {
						if (patch.sessionTarget === null) delete next.sessionTarget;
						// 跨 scope 更新不做本进程会话回填:这里的活跃会话属于本窗口
						// 的运行时,写进别的 scope 的任务会在拥有方派发时 switchTo
						// 失败。保持 {kind:"pinned"} 无 id,由拥有方在首次派发时
						// 兜底固定到自己的活跃会话(与跨 scope create 同一约定)。
						else next.sessionTarget = patch.sessionTarget;
					}
					if (patch.concurrencyPolicy !== undefined) {
						if (patch.concurrencyPolicy === null) delete next.concurrencyPolicy;
						else next.concurrencyPolicy = patch.concurrencyPolicy;
					}
					if (patch.timeoutMinutes !== undefined) {
						if (patch.timeoutMinutes === null) delete next.timeoutMinutes;
						else next.timeoutMinutes = patch.timeoutMinutes;
					}
					return next;
				});
				if (!result.found) return error(id, "schedule_update", `Task not found in any scope: ${command.taskId}`);
				return success(id, "schedule_update", { task: summaryFor(readTasks(result.scope, result.workspaceId).find((x) => x.id === command.taskId)!) });
			}

			case "schedule_delete": {
				const engine = engineFor(command.scope, command.workspaceId);
				if (engine) {
					const r = engine.delete(command.taskId);
					if (!r.ok) return error(id, "schedule_delete", r.error);
					return success(id, "schedule_delete", { ok: true as const, taskId: command.taskId });
				}
				const result = mutateTaskAnyScope(command.taskId, () => null);
				if (!result.found) return error(id, "schedule_delete", `Task not found in any scope: ${command.taskId}`);
				return success(id, "schedule_delete", { ok: true as const, taskId: command.taskId });
			}

			case "schedule_run_now": {
				const engine = engineFor(command.scope, command.workspaceId);
				if (engine) {
					const r = await engine.runNow(command.taskId);
					if (!r.ok) return error(id, "schedule_run_now", r.error);
					return success(id, "schedule_run_now", { fired: true, taskId: r.taskId, at: r.at });
				}
				// 跨 scope 立即运行:任务属于其他窗口的 sidecar,本进程无法替它
				// 派发。改为在任务上写 runRequestedAt 请求标记落盘,由拥有该
				// scope 的活跃引擎经 tasks.json 监听发现并手动触发一次;该 scope
				// 的 sidecar 尚未运行时,打开后 engine.load() 补跑(见引擎
				// consumeRunRequests)。限制与本地 runNow 一致:legacy 会话目标
				// 不支持,直接报错而不是写一个永远不会被消费的标记。
				const lookup = readTasksAllScopes().find((entry) => entry.task.id === command.taskId);
				if (!lookup) {
					return error(id, "schedule_run_now", `Task not found in any scope: ${command.taskId}`);
				}
				const unsupported = unsupportedSessionTargetReason(lookup.task);
				if (unsupported) return error(id, "schedule_run_now", unsupported);
				const result = mutateTaskAnyScope(command.taskId, (task) => ({
					...task,
					runRequestedAt: Date.now(),
					updatedAt: Date.now(),
				}));
				if (!result.found) {
					return error(id, "schedule_run_now", `Task not found in any scope: ${command.taskId}`);
				}
				// 拥有方 sidecar 活着 → 它的引擎毫秒级消费标记,如实报「已触发」;
				// 没活着 → 标记留到打开该项目时补跑,如实报「已排队」,别让用户
				// 以为已经在跑了。
				const ownerAlive = isScopeEngineAlive(lookup.scope, lookup.workspaceId);
				return success(id, "schedule_run_now", { fired: ownerAlive, taskId: command.taskId, at: Date.now() });
			}

			case "schedule_reload": {
				let reloaded = 0;
				for (const engine of schedulerEngines.values()) {
					reloaded += engine.reload();
				}
				return success(id, "schedule_reload", { reloaded });
			}

			case "schedule_history": {
				const runs = readRuns(command.scope, command.workspaceId, command.taskId, command.limit ?? 50);
				return success(id, "schedule_history", { runs });
			}

			case "get_replay_summary": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionId = command.sessionId ?? descriptor.session_id;
				const dir = getReplaySessionDir(descriptor.workspace_id, sessionId);
				const result = await loadReplaySummary(dir);
				if (result.status === "corrupt") {
					return error(id, "get_replay_summary", `replay-summary.json 解析失败：${result.message}`);
				}
				return success(id, "get_replay_summary", {
					sessionId,
					summary: result.status === "found" ? result.summary : null,
				});
			}

			case "list_replay_sessions": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessions = await listReplaySessions(descriptor.workspace_id);
				return success(id, "list_replay_sessions", { sessions });
			}

			case "list_replay_dir": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionId = command.sessionId ?? descriptor.session_id;
				const dir = getReplaySessionDir(descriptor.workspace_id, sessionId);
				const rel = (command.path ?? "").trim();
				const listing = await listArtifactDir(dir, rel);
				if (!listing.ok) {
					const messages = { denied: "路径越界：只能访问回放目录内的文件", not_dir: "not a directory", missing: "directory not found" } as const;
					return error(id, "list_replay_dir", messages[listing.reason]);
				}
				return success(id, "list_replay_dir", { path: rel === "" ? "/" : rel, entries: listing.entries });
			}

			case "read_replay_file": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionId = command.sessionId ?? descriptor.session_id;
				const rel = (command.path ?? "").trim();
				if (rel.length === 0) {
					return error(id, "read_replay_file", "missing path");
				}
				const dir = getReplaySessionDir(descriptor.workspace_id, sessionId);
				const file = await readArtifactFile(dir, rel);
				if (!file.ok) {
					const messages = {
						denied: "路径越界：只能访问回放目录内的文件",
						not_file: "not a file",
						too_large: file.message ?? "file too large",
						missing: "file not found",
					} as const;
					return error(id, "read_replay_file", messages[file.reason]);
				}
				return success(id, "read_replay_file", {
					name: file.name,
					mime: file.mime,
					size: file.data.length,
					data: file.data.toString("base64"),
				});
			}

		case "set_auto_retry":
				return success(id, "set_auto_retry");

			case "abort_retry":
				facade.abort();
				return success(id, "abort_retry");

			case "bash": {
				const operations = createLocalBashOperations();
				const result = await executeBashWithOperations(command.command, process.cwd(), operations);
				return success(id, "bash", result);
			}

			case "abort_bash":
				return success(id, "abort_bash");

			case "export_html": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionRef = makeSessionRef(descriptor.workspace_id, descriptor.session_id);
				const path = await exportFromFile(sessionRef, command.outputPath);
				return success(id, "export_html", { path });
			}

			case "set_steering_mode":
				return success(id, "set_steering_mode");

			case "set_follow_up_mode":
				return success(id, "set_follow_up_mode");
			case "approve":
				facade.runtime.approve(command.intentEventId);
				return success(id, "approve");

			case "reject":
				facade.runtime.reject(command.intentEventId);
				return success(id, "reject");

			case "set_safe_mode": {
				const enabled = !!command.enabled;
				facade.runtime.setSafeMode(enabled);
				facade.settingsManager.setSafeMode(enabled);
				return success(id, "set_safe_mode", { safeMode: facade.runtime.isSafeMode });
			}
		case "new_session": {
			const sm = facade.runtime.sessionManager;
			// 幂等守卫:当前活跃会话仍是空壳(无用户/助手内容、也没命名)时直接
			// 复用 —— 不挡的话每次点击都留下一个空会话库,侧栏被空行淹没。
			if (sm) {
				try {
					const desc = facade.getProjection().getDescriptor();
					if (sm.isActiveEmpty() && !desc.name) {
						return success(id, "new_session", { sessionId: desc.session_id });
					}
				} catch { /* fall through to create */ }
			}
			// 新对话 = 新会话库：独立的历史/时间线,与旧对话互不干涉。
			sm?.createThread();
			const sessionId = sm?.getActiveSessionId() ?? "";
			return success(id, "new_session", { sessionId });
		}

		case "get_skills": {
			const enableSkills = facade.settingsManager.getEnableSkillCommands();
			const skills = enableSkills
				? (facade.resourceLoader?.getSkills().skills ?? []).map((s) => ({
						command: `skill:${s.name}`,
						name: s.name,
						description: s.description,
					}))
				: [];
			return success(id, "get_skills", { skills });
		}

		case "get_extensions": {
			const extensions = await buildExtensionInfos(facade);
			return success(id, "get_extensions", { extensions });
		}

		case "set_extension_enabled": {
			const info = getBuiltinExtensionInfo(command.extensionId);
			if (!info) {
				return error(
					id,
					"set_extension_enabled",
					"Only built-in extensions can be toggled. Manage other extensions via `zharness plugin`.",
				);
			}
			facade.settingsManager.setBuiltinExtensionDisabled(command.extensionId, !command.enabled);
			// Disabling/enabling a built-in changes which extensions are loaded; that
			// only takes full effect after the session reloads its resources.
			return success(id, "set_extension_enabled", {
				id: command.extensionId,
				enabled: command.enabled,
				requiresReload: true,
			});
		}

		case "install_extension": {
			const result = await runExtensionLifecycle(facade, command.extensionId, "install");
			return success(id, "install_extension", {
				extensionId: command.extensionId,
				ok: result.ok,
				message: result.message,
				installed: result.installed,
			});
		}

		case "uninstall_extension": {
			const result = await runExtensionLifecycle(facade, command.extensionId, "uninstall");
			return success(id, "uninstall_extension", {
				extensionId: command.extensionId,
				ok: result.ok,
				message: result.message,
				installed: result.installed,
			});
		}

		case "install_skill": {
			// One install at a time: concurrent clones would race on git's global
			// locks and on the same target directory under <agentDir>/skills/.
			if (skillInstallInFlight) {
				return success(id, "install_skill", {
					slug: command.slug,
					ok: false,
					message: "Another skill install is already in progress. Try again once it finishes.",
				});
			}
			skillInstallInFlight = true;
			try {
				const result = await installSkillFromDirectory(command.source, command.slug);
				if (result.ok) {
					// Reload resources so the new skill shows up via get_skills,
					// then rebuild the system prompt so the RUNNING session sees
					// it in <available_skills> immediately (no sidecar restart).
					try {
						await facade.resourceLoader?.reload();
					} catch { /* non-fatal — the skill is on disk for the next load */ }
					try {
						facade.runtime.refreshSystemPrompt();
					} catch { /* non-fatal — new sessions still pick it up */ }
				}
				return success(id, "install_skill", { slug: command.slug, ok: result.ok, message: result.message });
			} finally {
				skillInstallInFlight = false;
			}
		}

		case "sop_list": {
			const sops = loadInstalledSops().sops.map(toRpcSopInfo);
			return success(id, "sop_list", { sops });
		}

		case "sop_market": {
			// 市场目录 = 内置模板(随应用分发)+ 已安装标记。内置模板读取
			// 失败(构建产物缺失)时降级为仅已安装列表,不让配置页报错。
			const installedSops = loadInstalledSops().sops;
			const installed = new Set(installedSops.map((s) => s.slug));
			const entries = listBuiltinSops().map((sop) => ({
				...toRpcMarketEntry(sop, "builtin"),
				installed: installed.has(sop.slug),
			}));
			// 已安装但不在内置列表里的(如 GitHub 装的、用户手放的)也以
			// github:unknown/installed 条目露出,便于管理卸载。
			for (const sop of installedSops) {
				if (entries.some((e) => e.slug === sop.slug)) continue;
				entries.push({ ...toRpcMarketEntry(sop, "github:unknown"), installed: true });
			}
			entries.sort((a, b) => a.slug.localeCompare(b.slug));
			return success(id, "sop_market", { entries });
		}

		case "sop_install": {
			// One install at a time: concurrent clones would race on git's global
			// locks and on the same target directory under <agentDir>/sops/.
			if (sopInstallInFlight) {
				return success(id, "sop_install", {
					slug: command.slug,
					ok: false,
					message: "Another SOP install is already in progress. Try again once it finishes.",
				});
			}
			sopInstallInFlight = true;
			try {
				const result =
					command.source === "builtin"
						? wrapBuiltinSopInstall(command.slug)
						: await installSopFromGitHub(command.source, command.slug);
				return success(id, "sop_install", { slug: command.slug, ok: result.ok, message: result.message });
			} finally {
				sopInstallInFlight = false;
			}
		}

		case "sop_uninstall": {
			const result = uninstallSop(command.slug);
			return success(id, "sop_uninstall", { slug: command.slug, ok: result.ok, message: result.message });
		}

		case "reload_providers": {
			// Credentials may be written to auth.json out-of-band (e.g. by the
			// desktop Tauri bridge). Reload the in-memory cache so model auth
			// resolution picks up the latest keys instead of a stale cache or an
			// env-var fallback. Also refresh the model registry so hasAuth flags
			// and any provider baseUrl overrides are recomputed.
			const registry = facade.modelRegistry;
			if (registry?.authStorage) {
				registry.authStorage.reload();
				registry.refresh();
			}
			return success(id, "reload_providers", {
				providers: registry?.authStorage?.list() ?? [],
			});
		}

		case "auth_set": {
			// Mobile clients live in a different sandbox than the engine and
			// cannot edit auth.json out-of-band; they push keys through the
			// bridge instead. The key is persisted to the engine-side
			// auth.json only — it never lands on the phone.
			const registry = facade.modelRegistry;
			const authStorage = registry?.authStorage;
			if (!authStorage) {
				return error(id, "auth_set", "Auth storage is not available");
			}
			const provider = typeof command.provider === "string" ? command.provider.trim() : "";
			const apiKey = typeof command.apiKey === "string" ? command.apiKey.trim() : "";
			if (!provider || provider.length > 128) {
				return error(id, "auth_set", "provider is required (max 128 chars)");
			}
			if (!apiKey || apiKey.length > 4096) {
				return error(id, "auth_set", "apiKey is required (max 4096 chars)");
			}
			authStorage.set(provider, { type: "api_key", key: apiKey });
			authStorage.reload();
			registry.refresh();
			return success(id, "auth_set", { providers: authStorage.list() });
		}

		case "auth_remove": {
			const registry = facade.modelRegistry;
			const authStorage = registry?.authStorage;
			if (!authStorage) {
				return error(id, "auth_remove", "Auth storage is not available");
			}
			const provider = typeof command.provider === "string" ? command.provider.trim() : "";
			if (!provider) {
				return error(id, "auth_remove", "provider is required");
			}
			authStorage.remove(provider);
			authStorage.reload();
			registry.refresh();
			return success(id, "auth_remove", { providers: authStorage.list() });
		}

		case "get_persona": {
			// Personified GUI support: expose the main-agent identity (SOUL.md)
			// and the user's long-term memory (user-profile.md + siblings) so a
			// GUI can render the agent as a character and the memory as a
			// profile card. Read-only; the agent keeps editing these files via
			// its normal tools. Payload assembly lives in core (`buildPersonaData`)
			// so it can be unit-tested without spawning a sidecar.
			// Note: GUI sidecars are always spawned with the default mainDir,
			// so the global default is authoritative here.
			return success(id, "get_persona", buildPersonaData(getMainDir()));
		}

		case "context_preview": {
			// 上下文编辑器（context-editor 内置扩展的查看面）：发送消息前查看
			// 「真正的上下文」——当前生效的系统提示词（含覆盖预演）、工具
			// 定义、以及从事件日志投影出的消息序列（含已施加编辑的预演）。
			// 只读，不消费任何 once 覆盖。
			const projection = facade.getProjection();
			// 不带 max_tokens：预览完整投影。真实发送按 contextBudget 截断
			// 最旧消息（见 SessionProjection._truncateByTokens），超长会话中
			// 预览可能比实际发送多出最旧的一段。
			const snapshot = getContextEditorSnapshot();
			const currentSystemPrompt = facade.systemPrompt;
			const planned = planSystemPromptForSend(currentSystemPrompt);
			const effectiveSystemPrompt = planned.result ?? currentSystemPrompt;

			const messages: RpcContextMessage[] = buildContextMessageViews(facade);
			if (typeof command.pendingUserMessage === "string" && command.pendingUserMessage.length > 0) {
				messages.push({
					kind: "user",
					role: "user",
					text: command.pendingUserMessage,
					sentToLlm: true,
					editable: false,
					deletable: false,
					note: "待发送消息：点「发送」后进入事件日志并成为上下文的一部分",
					charCount: command.pendingUserMessage.length,
				});
			}

			const tools: RpcContextTool[] = facade.tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parametersJson: JSON.stringify(tool.input_schema ?? {}, null, 2),
			}));

			const data: RpcContextPreviewData = {
				effectiveSystemPrompt,
				currentSystemPrompt,
				systemPromptOverridden: planned.result !== undefined && planned.result !== currentSystemPrompt,
				systemPromptOverrideScope: snapshot.systemPromptOverride?.scope,
				tools,
				messages,
				pendingUserMessage:
					typeof command.pendingUserMessage === "string" && command.pendingUserMessage.length > 0
						? command.pendingUserMessage
						: undefined,
				extensionLoaded: snapshot.loaded,
				overrides: toOverridesSnapshot(snapshot),
				sessionId: projection.getDescriptor().session_id,
			};
			return success(id, "context_preview", data);
		}

		case "context_apply": {
			// 施加编辑（事务性：任一条目非法则整体失败，不落任何状态）。
			if (facade.isRunning) {
				return error(
					id,
					"context_apply",
					"当前回复仍在进行中：此时施加的编辑可能被进行中的 LLM 请求立即消费。请等待本轮完成后再应用。",
				);
			}
			if (!isContextEditorLoaded()) {
				return error(
					id,
					"context_apply",
					"context-editor 扩展未加载，编辑不会生效。请在「配置管理 → 扩展」启用 context-editor 并重启会话。",
				);
			}

			if (command.systemPrompt !== undefined) {
				if (command.systemPrompt === null) {
					// 清除覆盖：若 persistent 覆盖已在本轮 prompt 中被应用到 runtime，
					// 需要把捕获的原提示词写回，否则编辑会一直残留。
					const base = getContextEditorSnapshot().baseBeforePersistent;
					clearSystemPromptOverride();
					if (base !== undefined && facade.systemPrompt !== base) {
						facade.systemPrompt = base;
					}
					setBaseBeforePersistent(undefined);
				} else if (typeof command.systemPrompt.text === "string" && command.systemPrompt.text.length > 0) {
					// 首次进入 persistent 覆盖时记录原提示词，供清除时恢复。
					if (
						command.systemPrompt.scope === "persistent" &&
						getContextEditorSnapshot().systemPromptOverride?.scope !== "persistent"
					) {
						setBaseBeforePersistent(facade.systemPrompt);
					}
					setSystemPromptOverride(command.systemPrompt.text, command.systemPrompt.scope);
				} else {
					return error(id, "context_apply", "systemPrompt.text 不能为空");
				}
			}

			if (command.messageEdits && command.messageEdits.length > 0) {
				// 逐条校验：eventId 必须存在于当前投影，且目标消息允许该操作。
				const built = facade.getProjection().buildContext();
				const sourceIds = built.sourceEventIds ?? [];
				const byEventId = new Map<string, { index: number }>();
				sourceIds.forEach((eventId, index) => {
					if (eventId && !byEventId.has(eventId)) byEventId.set(eventId, { index });
				});
				const problems: string[] = [];
				for (const entry of command.messageEdits) {
					if (!entry.eventId) {
						problems.push("缺少 eventId");
						continue;
					}
					const found = byEventId.get(entry.eventId);
					if (!found) {
						problems.push(`${entry.eventId} 不在当前上下文中（可能已被压缩/截断移除）`);
						continue;
					}
					if (entry.action === "edit") {
						const view = toContextMessageView(built.messages[found.index]!, entry.eventId);
						if (!view.editable) {
							problems.push(`${entry.eventId}（${view.kind}）不可编辑：${view.note ?? "该消息不会发送给 LLM"}`);
						} else if (typeof entry.text !== "string") {
							problems.push(`${entry.eventId} 的 edit 操作缺少 text`);
						}
					} else if (entry.action === "delete") {
						const view = toContextMessageView(built.messages[found.index]!, entry.eventId);
						if (!view.deletable) {
							problems.push(`${entry.eventId}（${view.kind}）不可删除：${view.note ?? "该消息不会发送给 LLM"}`);
						}
					}
					// action === "clear"：撤销该消息上的既有编辑，只需 eventId 有效。
				}
				if (problems.length > 0) {
					return error(id, "context_apply", `存在非法编辑，未应用任何改动：${problems.join("；")}`);
				}
				for (const entry of command.messageEdits) {
					if (entry.action === "clear") {
						clearMessageEdit(entry.eventId);
					} else if (entry.action === "edit") {
						setMessageEdit(entry.eventId, {
							action: "edit",
							text: entry.text ?? "",
							scope: entry.scope as OverrideScope,
						});
					} else {
						setMessageEdit(entry.eventId, { action: "delete", scope: entry.scope as OverrideScope });
					}
				}
			}

			return success(id, "context_apply", toOverridesSnapshot(getContextEditorSnapshot()));
		}

		case "context_overrides_clear": {
			const target = command.target ?? "all";
			if (target === "all" || target === "systemPrompt") {
				clearSystemPromptOverride();
				// 清除系统提示词覆盖时，恢复首次 persistent 覆盖前的原文本
				// （once 覆盖的还原由扩展 hook 的状态机在下一轮完成）。
				const base = getContextEditorSnapshot().baseBeforePersistent;
				if (base !== undefined && facade.systemPrompt !== base) {
					facade.systemPrompt = base;
				}
				setBaseBeforePersistent(undefined);
			}
			if (target === "all" || target === "messageEdits") {
				clearAllMessageEdits();
			}
			return success(id, "context_overrides_clear", toOverridesSnapshot(getContextEditorSnapshot()));
		}

		case "context_score": {
			// 上下文打分（context-editor 扩展）：用一次独立 LLM 调用评估
			// 「即将发送的上下文」。实时性差 → start 立即返回 running，
			// 前端轮询 status；结果按上下文指纹缓存，未变不重复花调用。
			if (command.action === "cancel") {
				return success(id, "context_score", cancelContextScore());
			}
			if (command.action === "status") {
				// running 期间跳过指纹比对（省一次投影构建）；有结果时
				// 附带 stale，让 UI 提示「上下文已变化」。草稿参与指纹，
				// 调用方轮询时带上与 start 相同的 pendingUserMessage。
				const current = getContextScoreStatus().status === "done"
					? computeContextFingerprint(buildContextScoreInput(facade, command.pendingUserMessage))
					: undefined;
				return success(id, "context_score", getContextScoreStatus(current));
			}
			// action === "start"
			if (facade.isRunning) {
				return error(
					id,
					"context_score",
					"当前回复仍在进行中，上下文正在变化：请等本轮完成后再打分。",
				);
			}
			const llmClient = facade.runtime.llmClient;
			if (!llmClient) {
				return error(
					id,
					"context_score",
					"当前没有可用的模型（未配置 API Key 或未选择模型）：无法打分。",
				);
			}
			const input = buildContextScoreInput(facade, command.pendingUserMessage);
			return success(
				id,
				"context_score",
				startContextScore({
					llmClient,
					model: facade.runtime.getModel(),
					input,
					force: command.force,
				}),
			);
		}

		case "proactive_assistant": {
			// 主动式交互助手（proactive-assistant 内置扩展的数据操作面）。
			// list / dismiss / apply / knowledge_draft / knowledge_save / clear / mute，
			// 与 /assistant 斜杠命令、GUI 浮动小助手共享 store.ts 的同一份内存状态。
			switch (command.action) {
				case "list": {
					return success(id, "proactive_assistant", {
						extensionLoaded: isProactiveAssistantLoaded(),
						suggestions: listActiveSuggestions(),
						mutedUntil: getMutedUntil(),
						userTurns: getUserTurns(),
						knowledgeOffered: hasOfferedKnowledge(),
					});
				}
				case "dismiss": {
					return success(id, "proactive_assistant", {
						dismissed: dismissSuggestion(command.suggestionId),
					});
				}
				case "apply": {
					const suggestion = getSuggestion(command.suggestionId);
					if (!suggestion) {
						return error(id, "proactive_assistant", `建议不存在或已处理：${command.suggestionId}`);
					}
					// 建议可能有多个动作；apply 施加第一个非 dismiss 动作
					//（GUI 卡片按钮已按动作分别调用，这里取首个作为命令行快捷方式）。
					const action =
						suggestion.actions.find((a) => a.kind !== "dismiss") ?? { kind: "dismiss" as const };
					switch (action.kind) {
						case "compact": {
							facade.compact();
							markApplied(suggestion.id);
							return success(id, "proactive_assistant", { applied: true, action: "compact" });
						}
						case "steer": {
							if (facade.isRunning) {
								facade.steer(action.text);
							} else {
								void facade.prompt(action.text).catch(() => {
									// 发送失败时建议保留，用户可重试。
								});
							}
							markApplied(suggestion.id);
							return success(id, "proactive_assistant", { applied: true, action: "steer" });
						}
						case "continue": {
							const text = "继续";
							if (facade.isRunning) {
								facade.steer(text);
							} else {
								void facade.prompt(text).catch(() => {});
							}
							markApplied(suggestion.id);
							return success(id, "proactive_assistant", { applied: true, action: "continue" });
						}
						case "save_knowledge": {
							// 沉淀走草稿→编辑→保存的完整流程，apply 不直接落盘。
							return error(
								id,
								"proactive_assistant",
								"知识沉淀请通过 knowledge_draft → 编辑确认 → knowledge_save 流程完成。",
							);
						}
						case "dismiss": {
							dismissSuggestion(suggestion.id);
							return success(id, "proactive_assistant", { applied: true, action: "dismiss" });
						}
					}
				}
				case "knowledge_draft": {
					// 从会话投影生成草稿：用户目标（首条用户消息）+ 过程统计 +
					// 最终结论（最后一条 assistant 文本）。用户编辑确认后另存。
					const built = facade.getProjection().buildContext();
					const messages = built.messages;
					const firstUserText = extractMessageText(
						messages.find((m) => m.role === "user")?.content,
					);
					const lastAssistantText = getLastAssistantText(messages) ?? undefined;
					const totals = getTotalToolStats();
					const draft = buildKnowledgeDraft({
						firstUserMessage: firstUserText,
						lastAssistantText,
						toolCalls: totals.toolCalls,
						toolFailures: totals.toolFailures,
						userTurns: getUserTurns(),
						sessionId: facade.getProjection().getDescriptor().session_id,
					});
					return success(id, "proactive_assistant", {
						...draft,
						suggestionId: command.suggestionId,
					});
				}
				case "knowledge_save": {
					if (!command.title.trim() || !command.content.trim()) {
						return error(id, "proactive_assistant", "知识标题与内容不能为空");
					}
					const result = saveKnowledge({
						title: command.title,
						content: command.content,
						tags: command.tags ?? ["knowledge"],
					});
					return success(id, "proactive_assistant", result);
				}
				case "clear": {
					clearSuggestions();
					return success(id, "proactive_assistant", { cleared: true });
				}
				case "mute": {
					const until = mute(Math.max(0, command.minutes));
					return success(id, "proactive_assistant", { mutedUntil: until });
				}
			}
		}

		case "task_board": {
			// 任务看板（task-board 内置扩展的数据面）：GUI 首页看板经此读写
			// 与 `task_board` agent 工具 / `/taskboard` 命令同一份 task-board.json。
			const workspaceId = resolveCommandBoardWorkspaceId(command, facade);
			const store = facade.runtime.store;
			switch (command.action) {
				case "list": {
					const tasks = listTasks(workspaceId);
					return success(id, "task_board", { action: "list", tasks });
				}
				case "create": {
					const title = typeof command.title === "string" ? command.title.trim() : "";
					if (!title) return error(id, "task_board", "title is required");
					const task = createTask(workspaceId, {
					title,
					project: command.project,
					priority: command.priority,
					status: command.status,
					zentaoId: command.zentaoId,
					dueAt: command.dueAt,
				});
					emitTaskBoardChanged(store, `创建任务：${task.title}`);
					return success(id, "task_board", { action: "create", task });
				}
				case "update": {
					const task = updateTask(workspaceId, command.taskId, {
					title: command.title,
					project: command.project,
					priority: command.priority,
					status: command.status,
					zentaoId: command.zentaoId,
					dueAt: command.dueAt,
				});
					if (task) {
						emitTaskBoardChanged(store, `更新任务：${task.title}`);
					}
					return success(id, "task_board", { action: "update", task });
				}
				case "delete": {
					const deleted = deleteTask(workspaceId, command.taskId);
					if (deleted) {
						emitTaskBoardChanged(store, `删除任务：${command.taskId}`);
					}
					return success(id, "task_board", { action: "delete", deleted });
				}
			}
		}

		case "skin_state": {
			// 换肤插件（skins 内置扩展的数据面）：GUI 设置页皮肤库经此读取
			// 与 `skin` agent 工具 / `/skins` 命令同一份 skins.json。
			const state = getSkinState();
			return success(id, "skin_state", {
				skins: state.skins.map(toRpcSkin),
				activeSkinId: state.activeSkinId,
			});
		}

		case "skin_apply": {
			const skinId = typeof command.skinId === "string" ? command.skinId.trim() : "";
			if (!skinId) return error(id, "skin_apply", "skinId is required");
			const skin = applySkin(skinId, { dim: command.dim, blur: command.blur });
			if (skin) {
				emitSkinChanged(facade.runtime.store, `启用皮肤：${skin.name}`);
			}
			return success(id, "skin_apply", { skin: skin ? toRpcSkin(skin) : null });
		}

		case "skin_add": {
			const name = typeof command.name === "string" ? command.name : "";
			const dataUrl = typeof command.dataUrl === "string" ? command.dataUrl : "";
			try {
				const skin = addCustomSkin({ name, dataUrl, dim: command.dim, blur: command.blur });
				emitSkinChanged(facade.runtime.store, `新增自定义皮肤：${skin.name}`);
				return success(id, "skin_add", { skin: toRpcSkin(skin) });
			} catch (e) {
				return error(id, "skin_add", e instanceof Error ? e.message : String(e));
			}
		}

		case "skin_remove": {
			const skinId = typeof command.skinId === "string" ? command.skinId : "";
			const removed = removeCustomSkin(skinId);
			if (removed) {
				emitSkinChanged(facade.runtime.store, `删除自定义皮肤：${skinId}`);
			}
			return success(id, "skin_remove", { removed });
		}

		case "skin_image": {
			const skinId = typeof command.skinId === "string" ? command.skinId : "";
			return success(id, "skin_image", { dataUrl: readSkinImage(skinId) });
		}

		case "skin_rename": {
			const skinId = typeof command.skinId === "string" ? command.skinId : "";
			const name = typeof command.name === "string" ? command.name : "";
			const skin = renameCustomSkin(skinId, name);
			const known = skin ?? findSkin(skinId);
			if (skin) {
				emitSkinChanged(facade.runtime.store, `皮肤改名：${skin.name}`);
			}
			return success(id, "skin_rename", { skin: known ? toRpcSkin(known) : null });
		}

		case "pet_state": {
			// 宠物插件（pets 内置扩展的数据面）：GUI 浮动挂件经此读写
			// 与 `pet` agent 工具 / `/pets` 命令同一份 pets.json。
			const state = getPetsState();
			return success(id, "pet_state", {
				pets: state.pets,
				activePetId: state.activePetId,
				activePetView: getActivePetView(),
				totalHatched: state.totalHatched,
			});
		}

		case "pet_hatch": {
			const { pet, draw, overflow } = hatchPet();
			if (!overflow) {
				emitPetsChanged(facade.runtime.store, `开盲盒抽到 ${pet.name}（${pet.rarity}${pet.shiny ? " · 闪光" : ""}）`);
			}
			return success(id, "pet_hatch", {
				pet: overflow ? null : pet,
				draw: {
					speciesId: draw.species.id,
					speciesName: draw.species.name,
					rarity: draw.species.rarity,
					shiny: draw.shiny,
				},
				overflow,
			});
		}

		case "pet_interact": {
			const result = interactPet(command.petId, command.action);
			if (result.effected && result.pet) {
				emitPetsChanged(facade.runtime.store, `${command.action === "feed" ? "喂食" : "陪玩"}：${result.pet.name}`);
			}
			return success(id, "pet_interact", { kind: command.action, ...result });
		}

		case "pet_rename": {
			const pet = renamePet(command.petId, command.name);
			if (pet) {
				emitPetsChanged(facade.runtime.store, `宠物改名：${pet.name}`);
			}
			return success(id, "pet_rename", { pet });
		}

		case "pet_carry": {
			const pet = setActivePet(command.petId);
			if (pet) {
				emitPetsChanged(facade.runtime.store, `携带宠物切换为 ${pet.name}`);
			}
			return success(id, "pet_carry", { pet });
		}

		case "pet_release": {
			const released = releasePet(command.petId);
			if (released) {
				emitPetsChanged(facade.runtime.store, "放生了一只宠物");
			}
			return success(id, "pet_release", { released });
		}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingUIRequests.get(response.id);
			if (pending) {
				pendingUIRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	unsubscribe = facade.subscribe((event) => output(event));
	registerSignalHandlers();

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	return new Promise(() => {});
}
