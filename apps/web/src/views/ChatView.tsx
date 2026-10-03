import { useEffect, useRef, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import { sendCommandAwait, subscribeEvents, subscribeSidecarExit } from "@/lib/transport";
import type { RpcSessionState, TypedEvent } from "@/lib/types";
import { Conversation, type TimelineItem } from "@/components/Conversation";
import { Composer, type ComposerImage } from "@/components/Composer";
import { StatusDot } from "@/components/ui";
import { approveToolCall, rejectToolCall, historyTreeJump } from "@/lib/transport";
import { basename, cn } from "@/lib/utils";
import { usePersistedState } from "@/lib/usePersistedState";
import BranchTreeExplorer from "@/views/BranchTreeExplorer";
import EventTimeline from "@/views/EventTimeline";
import ExecutionStatus from "@/views/ExecutionStatus";
import ReplayView from "@/views/ReplayView";
import { useReplaySessionId } from "@/views/replay/useReplaySessionId";
import TaskSessionCard from "@/components/TaskSessionCard";
import { isMainChatCwd, type LayoutOutletContext } from "@/components/Layout";

/** 对话页顶部 tab（设计稿: 对话 | 历史 | 时间线 | 执行状态 | 回放）。 */
type ChatPageTab = "conversation" | "history" | "timeline" | "status" | "replay";

function blockToDataUrl(block: Record<string, unknown>): string | null {
	const data = block.data;
	if (typeof data !== "string" || !data) return null;
	const mime = (block.mime_type ?? block.mimeType ?? "image/png") as string;
	// Already a data URL?
	if (data.startsWith("data:")) return data;
	return `data:${mime};base64,${data}`;
}

/** Extract image data URLs from a message payload (content blocks + images array). */
function messageImages(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	const out: string[] = [];
	if (Array.isArray(msg.content)) {
		for (const block of msg.content as Array<Record<string, unknown>>) {
			if (block && typeof block === "object" && block.type === "image") {
				const url = blockToDataUrl(block);
				if (url) out.push(url);
			}
		}
	}
	if (Array.isArray(msg.images)) {
		for (const img of msg.images as Array<Record<string, unknown>>) {
			const url = blockToDataUrl(img);
			if (url) out.push(url);
		}
	}
	return out;
}

interface ExtractedToolCall {
	id: string;
	name: string;
	args: string;
}

/** Extract toolCall blocks (id, name, JSON args) from an assistant message. */
function messageToolCalls(message: unknown): ExtractedToolCall[] {
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	if (!Array.isArray(msg.content)) return [];
	const out: ExtractedToolCall[] = [];
	for (const block of msg.content as Array<Record<string, unknown>>) {
		if (block && typeof block === "object" && (block.type === "toolCall" || block.type === "tool_call")) {
			const args = (block.arguments ?? {}) as unknown;
			out.push({
				id: String(block.id ?? block.tool_call_id ?? ""),
				name: String(block.name ?? block.tool_name ?? "tool"),
				args: args && typeof args === "object" ? JSON.stringify(args) : String(args ?? ""),
			});
		}
	}
	return out;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((r) => {
			const b = r as Record<string, unknown>;
			return b?.type === "text" ? String(b.text ?? "") : "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageThinking(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (!Array.isArray(msg.content)) return "";
	return (msg.content as Array<Record<string, unknown>>)
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "thinking") return String(block.thinking ?? block.text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<Record<string, unknown>>)
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return String(block.text ?? "");
				if (block.type === "thinking") return "";
				if (block.type === "toolCall") return "";
				if (block.type === "image") return "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Append a streaming delta to the assistant bubble with the given id.
 *
 * Self-healing: if the bubble is gone (an absolute setItems replace — session
 * switch reload — landed mid-turn and wiped it), the bubble is recreated
 * instead of the delta being silently dropped. Without this, one ill-timed
 * reload swallowed the whole reply: every later chunk mapped over an items
 * array that no longer contained the target id.
 */
function appendDelta(
	prev: TimelineItem[],
	id: string,
	kind: "text" | "thinking",
	delta: string,
	t: (key: string) => string,
): TimelineItem[] {
	if (!prev.some((it) => it.id === id)) {
		return [
			...prev,
			{
				id,
				role: "assistant",
				title: t("common.zharness"),
				text: kind === "text" ? delta : "",
				thinking: kind === "thinking" ? delta : undefined,
				status: "STREAMING",
				streaming: true,
			},
		];
	}
	return prev.map((it) =>
		it.id === id
			? kind === "text"
				? { ...it, text: it.text + delta }
				: { ...it, thinking: (it.thinking ?? "") + delta }
			: it,
	);
}

/** Build a TimelineItem[] from a get_messages response, matching tool cards to results. */
function buildTimelineFromMessages(
	messages: Array<Record<string, unknown>>,
	t: (key: string) => string,
): TimelineItem[] {
	const history: TimelineItem[] = [];
	// Track tool cards by tool_call_id so toolResult messages can fill them.
	const toolCardById = new Map<string, TimelineItem>();
	for (const msg of messages) {
		const role = msg.role as string;
		const ts = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
		if (role === "user") {
			const text = messageText(msg);
			const images = messageImages(msg);
			history.push({ id: `hist-${history.length}`, role: "user", title: t("common.you"), text, status: "", images: images.length > 0 ? images : undefined, timestamp: ts });
		} else if (role === "assistant") {
			const text = messageText(msg);
			const thinking = messageThinking(msg);
			const images = messageImages(msg);
			if (text || thinking || images.length > 0) {
				history.push({ id: `hist-${history.length}`, role: "assistant", title: t("common.zharness"), text, status: "DONE", streaming: false, thinking: thinking || undefined, images: images.length > 0 ? images : undefined, timestamp: ts });
			}
			// Emit a tool card for each tool call in the assistant message.
			for (const call of messageToolCalls(msg)) {
				const card: TimelineItem = {
					id: call.id || `hist-tool-${history.length}`,
					role: "tool",
					title: call.name,
					text: "",
					status: "DONE",
					streaming: false,
					toolName: call.name,
					toolArgs: call.args,
				};
				history.push(card);
				if (call.id) toolCardById.set(call.id, card);
			}
		} else if (role === "toolResult" || role === "tool") {
			const toolCallId = String(msg.toolCallId ?? msg.tool_call_id ?? "");
			const resultText = toolResultText(msg.content);
			const isError = msg.isError === true || msg.is_error === true;
			const existing = toolCallId ? toolCardById.get(toolCallId) : undefined;
			if (existing) {
				existing.toolResult = resultText;
				existing.isError = isError;
				existing.status = isError ? "ERROR" : "DONE";
			} else {
				// Orphan result (no matching call) — still show it.
				history.push({ id: `hist-${history.length}`, role: "tool", title: String(msg.toolName ?? msg.name ?? "tool"), text: "", status: isError ? "ERROR" : "DONE", streaming: false, toolName: String(msg.toolName ?? msg.name ?? "tool"), toolResult: resultText, isError });
				// (title intentionally uses raw tool name, not translated)
			}
		} else if (role === "branchSummary") {
			// 对话摘要卡（BRANCH_SUMMARY）。现行流程已不产生该事件（摘要重开
			// 机制随线程隔离删除）；此分支仅兜底展示迁移旧数据里的残留事件。
			const summary = typeof msg.summary === "string" ? msg.summary.replace(/\s+/g, " ").trim() : "";
			if (summary) {
				history.push({ id: `hist-${history.length}`, role: "system", title: t("chat.historySummary"), text: summary, status: "", streaming: false, timestamp: ts });
			}
		} else if (role === "custom") {
			// Extension command output (e.g. "/codegen status") replayed from
			// history. Only displayable string payloads become bubbles.
			if (msg.display === false) continue;
			const text = typeof msg.content === "string" ? msg.content : "";
			if (!text) continue;
			history.push({ id: `hist-${history.length}`, role: "assistant", title: t("common.zharness"), text, status: "DONE", streaming: false, timestamp: ts });
		}
	}
	return history;
}

/**
 * 空对话欢迎卡 —— 按设计稿「首页」实现:
 * 居中机器人插画(浅色 配图.png / 深色 机器人.png) + 主标题 + 运行状态 + 工作目录路径。
 * 顶部蓝色径向光晕由对话列容器绘制;输入框(Composer)紧跟本卡下方,整体垂直居中。
 */
function AgentIdentityCard({
	workspace,
	status,
	tone,
}: {
	workspace?: string | null;
	status: string;
	tone: "success" | "danger" | "neutral";
}) {
	const { t } = useTranslation();
	return (
		<div className="flex w-full flex-col items-center gap-5 px-6 pb-2 pt-4 text-center">
			<img
				src="/ui/misc/avatar-light.png"
				alt=""
				draggable={false}
				className="h-[88px] w-auto select-none dark:hidden"
			/>
			<img
				src="/ui/misc/avatar-dark.png"
				alt=""
				draggable={false}
				className="hidden h-[88px] w-auto select-none dark:block"
			/>
			<h1 className="text-[20px] font-semibold leading-tight tracking-tight text-fg">
				{t("chat.welcomeTitle")}
			</h1>
			<p className="-mt-2 flex items-center gap-1.5 text-xs text-muted">
				<StatusDot tone={tone} />
				{status}
			</p>
			{workspace && (
				<p className="max-w-full truncate font-mono text-[11px] text-muted/60" title={workspace}>
					{workspace}
				</p>
			)}
		</div>
	);
}

export default function ChatView({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	switchingWorkspace,
	viewingSessionId,
	onExitViewing,
	onRefreshState,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	/** 正在切换到的目标工作区(未落地):期间显示启动卡而不是旧工作区的内容。 */
	switchingWorkspace?: string | null;
	/** 查看中的历史会话(侧栏旧行点击)。null/等于活跃会话 = 跟随活跃对话。 */
	viewingSessionId?: string | null;
	/** 退出查看模式,回到当前活跃对话。 */
	onExitViewing?: () => void;
	onRefreshState?: () => void;
}) {
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const { t } = useTranslation();
	const [tab, setTab] = usePersistedState<ChatPageTab>("chat-page-tab", "conversation");
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [error, setError] = useState("");
	const activeAssistantRef = useRef<string | null>(null);

	// 切换进行中:目标工作区尚未落地。主对话的点击值是 ~ 路径而 workspace
	// 是展开后的绝对路径,按主对话判定归一化,避免落地前一帧误判为仍在切换。
	const switching =
		switchingWorkspace != null &&
		switchingWorkspace !== workspace &&
		!(isMainChatCwd(switchingWorkspace) && isMainChatCwd(workspace));
	// 切换期间标题/身份卡/输入框都按目标工作区展示。
	const displayWorkspace = switching ? switchingWorkspace : workspace;

	// 新会话(新建对话/看板启动任务/fork)后回到「对话」tab,而不是停留在
	// 上次持久化的 tab(否则新会话落在「回放」上显示空态,像没反应)。
	const sessionIdForTab = state?.sessionId ?? null;
	const prevSessionForTabRef = useRef(sessionIdForTab);
	useEffect(() => {
		if (prevSessionForTabRef.current !== sessionIdForTab) {
			prevSessionForTabRef.current = sessionIdForTab;
			setTab("conversation");
		}
	}, [sessionIdForTab, setTab]);
	const seenIdsRef = useRef<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);

	// Per-workspace conversation persistence.
	const itemsByWs = useRef<Map<string, TimelineItem[]>>(new Map());
	const seenIdsByWs = useRef<Map<string, Set<string>>>(new Map());
	const activeAssistantByWs = useRef<Map<string, string | null>>(new Map());
	const itemsRef = useRef<TimelineItem[]>([]);
	itemsRef.current = items;
	const prevWsRef = useRef<string | null>(null);

	// Keep latest t in a ref so closures created in effects can read it
	// without re-subscribing on every language change.
	const tRef = useRef(t);
	useEffect(() => { tRef.current = t; }, [t]);

	// --- Session-switch reload (jump/fork from BranchTreeExplorer) ---
	// When the active session changes via SESSION_FORKED or SESSION_JUMPED,
	// the ChatView's current items belong to the OLD session. We clear them
	// and re-fetch get_messages for the NEW active session. Debounced so a
	// fork (which emits both SESSION_CREATED + SESSION_FORKED) only reloads
	// once. A session_split emits SESSION_BOUNDARY_INFERRED instead, handled
	// separately below (a lightweight trim, not a full reload, so an
	// in-flight streaming turn isn't interrupted).
	const sessionSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 回合进行中到达的会话切换重载:不清屏(会把流式气泡连根清掉、后续
	// chunk 全部丢失),挂起等 AGENT_TURN_COMPLETED 后再执行。
	const pendingReloadRef = useRef(false);
	const reloadForSessionSwitch = useCallback(() => {
		if (itemsRef.current.some((it) => it.streaming)) {
			pendingReloadRef.current = true;
			return;
		}
		const ws = workspace ?? "";
		// Clear the per-workspace cache so a later workspace switch doesn't
		// restore the stale (pre-switch) conversation.
		itemsByWs.current.delete(ws);
		seenIdsByWs.current.delete(ws);
		activeAssistantByWs.current.delete(ws);
		// Reset current state — the new active session's messages will
		// replace whatever we were showing.
		setItems([]);
		seenIdsRef.current = new Set();
		activeAssistantRef.current = null;
		setError("");
		// Re-fetch the new active session's messages.
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait({ type: "get_messages" }, 30000);
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				const history = buildTimelineFromMessages(messages, tRef.current);
				if (!cancelled) setItems(history);
			} catch {
				// Silently ignore — the empty state will show.
			}
		})();
		return () => { cancelled = true; };
	}, [workspace]);

	// Save/restore conversation on workspace switch.
	useEffect(() => {
		const prevWs = prevWsRef.current;
		const newWs = workspace ?? "";
		if (prevWs !== newWs) {
			// Save current conversation under the old workspace.
			if (prevWs) {
				itemsByWs.current.set(prevWs, itemsRef.current);
				seenIdsByWs.current.set(prevWs, seenIdsRef.current);
				activeAssistantByWs.current.set(prevWs, activeAssistantRef.current);
			}
			// Restore conversation for the new workspace.
			setItems(itemsByWs.current.get(newWs) ?? []);
			seenIdsRef.current = seenIdsByWs.current.get(newWs) ?? new Set();
			activeAssistantRef.current = activeAssistantByWs.current.get(newWs) ?? null;
			setError("");
			prevWsRef.current = newWs;
		}
	}, [workspace]);

	// 查看历史会话:目标不是当前活跃会话时,输入/事件流都属于活跃对话,
	// 不能混入只读的历史视图 —— 事件抑制 + 发消息先重开,都按它判定。
	const viewingOld = viewingSessionId != null && viewingSessionId !== (state?.sessionId ?? null);
	// handleEvent 的 ref 镜像:抑制判定不随查看态翻转而重新订阅事件流。
	const viewingOldRef = useRef(false);
	viewingOldRef.current = viewingOld;

	// 查看目标变化(进入/切换/退出查看):整段重拉。进入查看按会话有界区间
	// 取「对话全链」;退出查看回到活跃对话。不复用工作区缓存 —— 查看内容
	// 是历史的,缓存属于活跃对话,互相覆盖会把另一段对话串进当前视图。
	const viewingRef = useRef<string | null>(null);
	// handleSend 的查看重开流程自行完成「退出查看前」的取数后置位:跳过
	// 下面这个 effect 在退出查看时的重拉,避免其异步返回与回合事件竞速,
	// setItems 整体替换吞掉刚开场的流式气泡。
	const skipExitRefetchRef = useRef(false);
	useEffect(() => {
		const target = viewingSessionId ?? null;
		const prev = viewingRef.current;
		viewingRef.current = target;
		if (prev === target) return;
		if (!sidecarReady) return;
		if (target === null && skipExitRefetchRef.current) {
			skipExitRefetchRef.current = false;
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const cmd = target
					? { type: "get_messages", sessionId: target }
					: { type: "get_messages" };
				const r = await sendCommandAwait(cmd as Parameters<typeof sendCommandAwait>[0], 30000);
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				setItems(buildTimelineFromMessages(messages, tRef.current));
				seenIdsRef.current = new Set();
				activeAssistantRef.current = null;
				setError("");
			} catch {
				// 拉取失败(如会话已被清理):空态展示。
				setItems([]);
			}
		})();
		return () => { cancelled = true; };
		// state?.sessionId:活跃会话变化(如 jump 重开)后,若查看目标恰好
		// 变成新活跃会话,viewingOld 翻转需要重算 —— 但查看目标本身没变,
		// 这里只在 target 变化时重拉。
	}, [viewingSessionId, sidecarReady]);

	// Load history from sidecar when sidecar becomes ready or workspace changes.
	useEffect(() => {
		if (!sidecarReady || !workspace) return;
		// 查看模式由上面的 viewingSessionId 效果负责取数;这里只管活跃对话,
		// 且查看中不落缓存(否则退出查看时会把历史内容当活跃对话缓存)。
		if (viewingSessionId) return;
		// If we already have cached items for this workspace (from a previous
		// visit this session), don't reload — the save/restore mechanism already
		// restored them. Otherwise, fetch from sidecar.
		const cached = itemsByWs.current.get(workspace);
		if (cached && cached.length > 0) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait({ type: "get_messages" }, 30000);
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				const history = buildTimelineFromMessages(messages, tRef.current);
				if (!cancelled && history.length > 0) {
					setItems(history);
				}
			} catch {
				// Silently ignore — history will load on next workspace switch.
			}
		})();
		return () => { cancelled = true; };
	}, [sidecarReady, workspace, viewingSessionId]);

	// Stick-to-bottom auto-scroll: only pin the view to the latest message
	// while the user is already near the bottom. As soon as they scroll up
	// (e.g. to read the expanded thinking process mid-stream), stop forcing
	// the scroll so the view stays where they put it; scrolling back to the
	// bottom re-enables following.
	const stickToBottomRef = useRef(true);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		};
		el.addEventListener("scroll", onScroll);
		return () => el.removeEventListener("scroll", onScroll);
	}, []);
	useEffect(() => {
		if (scrollRef.current && stickToBottomRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [items]);

	const handleEvent = useCallback((event: TypedEvent & { _cwd?: string }) => {
		const eventCwd = event._cwd ?? "";
		const currentWs = workspace ?? "";
		const isForCurrent = eventCwd === currentWs;

		// 查看历史会话时,活跃对话的实时事件(消息/工具/流式/切分)全部不混入
		// 只读的历史视图 —— 包括重载:后台若发生会话切换(定时任务等),不该
		// 把历史视图替换掉。唯一例外是工具审批:需要用户操作,自动退出查看
		// 回到活跃对话,避免审批卡被抑制后永远无人处理。(查看中发消息的
		// 重开流程会先退出查看、再触发重载,不经过这里。)
		if (viewingOldRef.current && isForCurrent) {
			if (event.type === "INTENT_TOOL_CALL" && (event.payload as { requires_approval?: boolean })?.requires_approval === true) {
				onExitViewing?.();
			}
			return;
		}

		// Determine which seenIds and activeAssistant to use.
		const seenRef = isForCurrent ? seenIdsRef : { current: seenIdsByWs.current.get(eventCwd) ?? new Set<string>() };
		if (seenRef.current.has(event.event_id)) return;
		seenRef.current.add(event.event_id);
		if (!isForCurrent) {
			seenIdsByWs.current.set(eventCwd, seenRef.current);
		}

		const activeRef = isForCurrent ? activeAssistantRef : { current: activeAssistantByWs.current.get(eventCwd) ?? null };

		const updateItems = (fn: (prev: TimelineItem[]) => TimelineItem[]) => {
			if (isForCurrent) {
				setItems(fn);
			} else {
				const cached = itemsByWs.current.get(eventCwd) ?? [];
				itemsByWs.current.set(eventCwd, fn(cached));
			}
		};

		// INTENT_TOOL_CALL and TOOL_EXECUTION_START share the same tool_call_id.
		// Upsert so we don't create duplicate cards / clashing React keys.
		const toolCardUpsert = (
			toolCallId: string,
			toolName: string,
			argsStr: string,
			approval?: TimelineItem["pendingApproval"],
		) => {
			updateItems((prev) => {
				const existing = prev.find((it) => it.id === toolCallId);
				if (existing) {
					return prev.map((it) =>
						it.id === toolCallId
							? {
									...it,
									title: toolName,
									toolName,
									toolArgs: argsStr || it.toolArgs,
									...(approval ? { pendingApproval: approval } : {}),
								}
							: it,
					);
				}
				return [
					...prev,
					{
						id: toolCallId,
						role: "tool",
						title: toolName,
						text: "",
						status: approval ? "PENDING" : "RUNNING",
						streaming: !approval,
						toolName,
						toolArgs: argsStr,
						...(approval ? { pendingApproval: approval } : {}),
					},
				];
			});
		};

		switch (event.type) {
			case "USER_MESSAGE": {
				const text = messageText(event.payload);
				const images = messageImages(event.payload);
				// When a queued follow-up is drained, the reactor emits a real
				// USER_MESSAGE whose caused_by points at the USER_FOLLOWUP_QUEUED
				// event we already rendered as a (queued) user bubble. Promote
				// that bubble in place (swap its id + clear the queued flag)
				// instead of appending a duplicate.
				const causedBy = typeof event.caused_by === "string" ? event.caused_by : undefined;
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => {
					if (causedBy) {
						const idx = prev.findIndex((it) => it.id === causedBy && it.queued);
						if (idx >= 0) {
							const next = [...prev];
							next[idx] = { ...next[idx]!, id: event.event_id, queued: false, status: "", timestamp: ts };
							return next;
						}
					}
					return [
						...prev,
						{ id: event.event_id, role: "user", title: tRef.current("common.you"), text, status: "", images: images.length > 0 ? images : undefined, timestamp: ts },
					];
				});
				break;
			}
			case "USER_FOLLOWUP_QUEUED": {
				// A follow-up sent while the agent is running is queued and only
				// delivered (as a real USER_MESSAGE) after the current turn ends.
				// Render it immediately as a "queued" user bubble so the user gets
				// feedback; it is promoted in place when the drained USER_MESSAGE
				// arrives (matched via caused_by).
				const text = messageText(event.payload);
				const images = messageImages(event.payload);
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => [
					...prev,
					{ id: event.event_id, role: "user", title: tRef.current("common.you"), text, status: "", images: images.length > 0 ? images : undefined, queued: true, timestamp: ts },
				]);
				break;
			}
			case "CUSTOM_MESSAGE": {
				// Extension command output (e.g. "/codegen status") surfaced as a
				// plain message bubble. Only render displayable string payloads.
				const payload = event.payload as { data?: unknown; display?: unknown };
				if (payload?.display === false) break;
				const data = payload?.data;
				const text = typeof data === "string" ? data : "";
				if (!text) break;
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => [
					...prev,
					{ id: event.event_id, role: "assistant", title: tRef.current("common.zharness"), text, status: "DONE", streaming: false, timestamp: ts },
				]);
				break;
			}
			case "AGENT_MESSAGE_START": {
				const id = event.event_id;
				activeRef.current = id;
				if (isForCurrent) {
					activeAssistantRef.current = id;
				} else {
					activeAssistantByWs.current.set(eventCwd, id);
				}
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => [
					...prev,
					{ id, role: "assistant", title: tRef.current("common.zharness"), text: "", status: "STREAMING", streaming: true, timestamp: ts },
				]);
				break;
			}
			case "AGENT_MESSAGE_CHUNK": {
				const id = activeRef.current;
				if (!id) break;
				const chunk = (event.payload as Record<string, unknown>)?.chunk as Record<string, unknown> | undefined;
				if (!chunk) break;
				if (chunk.kind === "text_delta" && typeof chunk.delta === "string") {
					updateItems((prev) => appendDelta(prev, id, "text", chunk.delta as string, tRef.current));
				} else if (chunk.kind === "thinking_delta" && typeof chunk.delta === "string") {
					updateItems((prev) => appendDelta(prev, id, "thinking", chunk.delta as string, tRef.current));
				}
				break;
			}
			case "AGENT_MESSAGE_END": {
				const id = activeRef.current;
				if (id) {
					const payload = event.payload as Record<string, unknown> | undefined;
					const content = payload?.content;
					const text = content ? messageText({ content }) : "";
					const thinking = content ? messageThinking({ content }) : "";
					const images = content ? messageImages({ content }) : [];
					const stopReason = String(payload?.stop_reason ?? "");
					const errorMessage = payload?.error_message
						? String(payload.error_message)
						: "";
					const isError = stopReason === "error" || Boolean(errorMessage);
					const fallbackText = isError && !text
						? errorMessage || tRef.current("chat.agentError", { reason: stopReason || "no response" })
						: text;
					const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
					// 气泡可能在流式中途被整段替换清掉(会话切换重载等):END 携带
					// 完整内容,缺失时原地重建,保证最终回复一定可见。
					updateItems((prev) => {
						if (!prev.some((it) => it.id === id)) {
							return [
								...prev,
								{
									id,
									role: "assistant" as const,
									title: tRef.current("common.zharness"),
									text: fallbackText,
									thinking: thinking || undefined,
									images: images.length > 0 ? images : undefined,
									status: isError ? ("ERROR" as const) : ("DONE" as const),
									streaming: false,
									isError: isError || undefined,
									timestamp: ts,
								},
							];
						}
						return prev.map((it) =>
							it.id === id
								? {
										...it,
										...(fallbackText ? { text: fallbackText } : {}),
										...(thinking ? { thinking } : {}),
										...(images.length > 0 ? { images } : {}),
										status: isError ? "ERROR" : "DONE",
										streaming: false,
										isError: isError || undefined,
									}
								: it,
						);
					});
					if (isError && errorMessage) {
						setError(errorMessage);
					}
				}
				break;
			}
			case "AGENT_TURN_COMPLETED": {
				const id = activeRef.current;
				const payload = event.payload as Record<string, unknown> | undefined;
				const reason = String(payload?.reason ?? "");
				const errorMessage = payload?.error_message
					? String(payload.error_message)
					: "";
				const isError = reason === "error" || Boolean(errorMessage);
				if (id) {
					updateItems((prev) =>
						prev.map((it) =>
							it.id === id
								? {
										...it,
										status: isError ? "ERROR" : "DONE",
										streaming: false,
										isError: isError || undefined,
									}
								: it,
						),
					);
					if (isForCurrent) {
						activeAssistantRef.current = null;
					} else {
						activeAssistantByWs.current.set(eventCwd, null);
					}
				}
				if (isError && errorMessage) {
					setError(errorMessage);
				}
				// 回合进行中被挂起的会话切换重载,现在安全了:执行它。
				if (isForCurrent && pendingReloadRef.current) {
					pendingReloadRef.current = false;
					if (sessionSwitchTimer.current) clearTimeout(sessionSwitchTimer.current);
					sessionSwitchTimer.current = setTimeout(() => {
						sessionSwitchTimer.current = null;
						reloadForSessionSwitch();
					}, 200);
				}
				break;
			}
			case "INTENT_TOOL_CALL": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const toolName = payload.tool_name as string;
				const args = (payload.arguments as Record<string, unknown> | undefined) ?? {};
				const argsStr = JSON.stringify(args, null, 2);
				const classification = payload.classification as Record<string, unknown> | undefined;
				// When safe mode is on, risky tool calls require explicit approval
				// before they execute. Render the approval inline on the tool card
				// (only for the active workspace; background ones just block).
				const requiresApproval = payload.requires_approval === true && isForCurrent;
				const approval = requiresApproval
					? {
							intentEventId: event.event_id,
							risk: classification?.risk as string | undefined,
							category: classification?.category as string | undefined,
							description: classification?.description as string | undefined,
							affectedFiles: classification?.affected_files as string[] | undefined,
							status: "pending" as const,
						}
					: undefined;
				toolCardUpsert(toolCallId, toolName, argsStr, approval);
				break;
			}
			case "TOOL_EXECUTION_START": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				// Execution started -> the tool was approved (or did not need approval).
				// Transition the card out of pending-approval into running.
				updateItems((prev) =>
					prev.map((it) =>
						it.id === toolCallId && it.role === "tool"
							? { ...it, pendingApproval: undefined, status: "RUNNING", streaming: true }
							: it,
					),
				);
				toolCardUpsert(
					toolCallId,
					payload.tool_name as string,
					payload.arguments ? JSON.stringify(payload.arguments, null, 2) : "",
				);
				break;
			}
			case "TOOL_EXECUTION_UPDATE": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const update = payload.update as string | undefined;
				if (update) {
					updateItems((prev) =>
						prev.map((it) =>
							it.id === toolCallId && it.role === "tool"
								? { ...it, toolResult: (it.toolResult ?? "") + update }
								: it,
						),
					);
				}
				break;
			}
			case "TOOL_EXECUTION_END": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const result = payload.result as Array<Record<string, unknown>> | undefined;
				const resultText = result
					? result.map((r) => (r.type === "text" ? String(r.text ?? "") : JSON.stringify(r))).join("\n")
					: "";
				const isError = payload.is_error === true;
				updateItems((prev) =>
					prev.map((it) =>
						it.id === toolCallId && it.role === "tool"
							? { ...it, status: isError ? "ERROR" : "DONE", streaming: false, toolResult: resultText || it.toolResult, isError }
							: it,
					),
				);
				break;
			}
			case "SESSION_BOUNDARY_INFERRED": {
				// A session_split created a new active session mid-turn. The new
				// session's start boundary is the most recent USER_MESSAGE, so
				// trim items to keep only that message onward. This refreshes the
				// header title (first user message) to reflect the new session
				// WITHOUT a full reload (which would clear the streaming pointer
				// and drop in-flight assistant chunks). Any assistant item after
				// the boundary is preserved so streaming continues uninterrupted.
				if (!isForCurrent) break;
				updateItems((prev) => {
					let idx = -1;
					for (let i = prev.length - 1; i >= 0; i--) {
						if (prev[i].role === "user" && prev[i].text.trim()) { idx = i; break; }
					}
					if (idx <= 0) return prev; // nothing to trim
					return prev.slice(idx);
				});
				break;
			}
			case "SESSION_CREATED":
			case "SESSION_FORKED":
			case "SESSION_JUMPED": {
				// The active session changed (user started a new session,
				// jumped/forked from the BranchTreeExplorer, or replayed
				// from the Timeline). Our current items belong to the OLD
				// session — reload from get_messages for the NEW active
				// session. Only react to events for the current workspace.
				// Debounced so a fork (which emits SESSION_CREATED +
				// SESSION_FORKED in quick succession) only triggers one
				// reload.
				if (!isForCurrent) break;
				if (sessionSwitchTimer.current) clearTimeout(sessionSwitchTimer.current);
				sessionSwitchTimer.current = setTimeout(() => {
					sessionSwitchTimer.current = null;
					reloadForSessionSwitch();
				}, 200);
				break;
			}
			default:
				break;
		}
		}, [workspace, reloadForSessionSwitch, onExitViewing]);
	// 每次渲染后同步最新 handleEvent 到 ref:事件订阅 effect 通过它调用,
	// 订阅本身不随 handleEvent 身份变化而重建(见上面的订阅 effect)。
	const handleEventRef = useRef(handleEvent);
	handleEventRef.current = handleEvent;

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		const unlisteners: Array<() => void> = [];
		(async () => {
			// 经 handleEventRef 间接调用:订阅生命周期只挂在 sidecarReady 上。
			// 若把 handleEvent 放进依赖,它的身份会随 workspace / onExitViewing
			// 变化而翻转 —— App 每次状态更新(每回合的 get_state)都会拆掉重挂
			// 订阅;Tauri listen/unlisten 高频翻转可能静默失败,一旦失败本视图
			// 永久收不到事件:回合在后端正常跑完、界面却什么都不渲染。
			const un1 = await subscribeEvents((event) => handleEventRef.current(event as TypedEvent));
			if (cancelled) { un1(); return; }
			unlisteners.push(un1);
			const un2 = await subscribeSidecarExit((code) => {
				if (code !== null) {
					setError(tRef.current("chat.sidecarExited", { code }));
				}
			});
			if (cancelled) { un2(); return; }
			unlisteners.push(un2);
		})();
		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, [sidecarReady]);

	// Cancel any pending session-switch reload on unmount.
	useEffect(() => {
		return () => {
			if (sessionSwitchTimer.current) clearTimeout(sessionSwitchTimer.current);
		};
	}, []);

	const handleSend = useCallback(
		async (message: string, images?: ComposerImage[]) => {
			setError("");
			// 从历史对话发消息:先 jump 切回该对话(活跃指针指向它,原地续写,
			// 不 fork、不带摘要 —— 摘要重开机制已删),取出该会话的落库历史,
			// 再退出查看、把 prompt 发上去。取数必须在发 prompt 之前完成:退出
			// 查看触发的重拉是异步的,其 setItems 整体替换若落在本回合的流式
			// 事件之后,会把刚开场的气泡吞掉 —— 因此这里同步取好,并用
			// skipExitRefetchRef 让退出查看的重拉跳过。切回失败(会话被清理等)
			// 则留在查看态并报错,不吞消息。
			if (viewingOld && viewingSessionId) {
				const targetId = viewingSessionId;
				try {
					await historyTreeJump(targetId, "continue_from_view");
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
					return;
				}
				skipExitRefetchRef.current = true;
				try {
					const r = await sendCommandAwait({ type: "get_messages" }, 30000);
					const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
					const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
					setItems(buildTimelineFromMessages(messages, tRef.current));
					seenIdsRef.current = new Set();
					activeAssistantRef.current = null;
				} catch {
					// 取数失败不阻断发送:保留查看内容,退出查看的 effect 兜底重拉。
					skipExitRefetchRef.current = false;
				}
				onExitViewing?.();
			}
			const payloadImages = images?.map((img) => ({ data: img.data, mimeType: img.mimeType }));
			// prompt/follow_up responses only arrive after the entire agent turn
			// completes (incl. all tool calls). All streaming content arrives via
			// the event subscription independently, so we fire-and-forget the command
			// and only catch immediate send errors (e.g. sidecar not running).
			try {
				const cmd = state?.isStreaming
					? { type: "follow_up", message, images: payloadImages }
					: { type: "prompt", message, images: payloadImages };
				sendCommandAwait(cmd, 600000).catch((e) => {
					setError(e instanceof Error ? e.message : String(e));
				});
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[state?.isStreaming, viewingOld, viewingSessionId, onExitViewing],
	);

	const handleAbort = useCallback(async () => {
		try {
			await sendCommandAwait({ type: "abort" }, 5000);
			// Abort may not always emit AGENT_TURN_COMPLETED, so proactively
			// refresh state to update isStreaming and flip the button back.
			void sendCommandAwait<RpcSessionState>({ type: "get_state" })
				.then((_r) => {
					// setState lives in App.tsx — we can't call it directly, but
					// the App-level event listener will also catch any turn-completed
					// event. As a fallback, mark the active assistant item as done.
					setItems((prev) =>
						prev.map((it) =>
							it.role === "assistant" && it.streaming
								? { ...it, status: "DONE", streaming: false }
								: it,
						),
					);
				})
				.catch(() => {});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	// Resolve an inline tool-call approval (approve/reject). Optimistically
	// updates the card, then fires the RPC; reverts on failure.
	const handleResolveApproval = useCallback(
		(intentEventId: string, toolCallId: string, approved: boolean) => {
			setItems((prev) =>
				prev.map((it) =>
					it.id === toolCallId && it.pendingApproval
						? {
								...it,
								pendingApproval: { ...it.pendingApproval, status: approved ? "approved" : "rejected" },
								status: approved ? it.status : "REJECTED",
								streaming: approved ? it.streaming : false,
							}
						: it,
				),
			);
			(async () => {
				try {
					if (approved) {
						await approveToolCall(intentEventId);
					} else {
						await rejectToolCall(intentEventId);
					}
				} catch (e) {
					// Revert the optimistic update on failure.
					setItems((prev) =>
						prev.map((it) =>
							it.id === toolCallId && it.pendingApproval
								? { ...it, pendingApproval: { ...it.pendingApproval, status: "pending" }, status: "PENDING", streaming: false }
								: it,
						),
					);
					setError(e instanceof Error ? e.message : String(e));
				}
			})();
		},
		[],
	);

	const isRunning = state?.isStreaming ?? false;
	// 空会话(含切换中):欢迎卡 + 输入框作为一组垂直居中,输入框紧贴工作目录路径下方。
	const isEmpty = switching || items.length === 0;

	// Session title: first user message (like Codex/ChatGPT), else workspace name.
	// 切换中 items 还是旧工作区的缓存,标题直接用目标工作区名。
	const firstUserText = switching
		? ""
		: (items.find((it) => it.role === "user" && it.text.trim())?.text.trim() ?? "");
	const wsName = displayWorkspace ? basename(displayWorkspace) : "";
	const sessionTitle = firstUserText
		? (firstUserText.length > 60 ? firstUserText.slice(0, 60).trimEnd() + "…" : firstUserText)
		: wsName || t("chat.newChat");

	// 回放 tab 的数据源:查看历史对话时播该对话,否则播当前会话(当前会话
	// 没有回放时由 hook 回退到工作区最新回放)。
	const replaySessionId = useReplaySessionId(viewingSessionId ?? state?.sessionId ?? null, sidecarReady);

	const chatTabs: Array<{ id: ChatPageTab; label: string }> = [
		{ id: "conversation", label: t("chat.tabConversation") },
		{ id: "history", label: t("history.title") },
		{ id: "timeline", label: t("timeline.title") },
		{ id: "status", label: t("execution.title") },
		{ id: "replay", label: t("layout.replay") },
	];

	return (
		<div className="flex h-full flex-col">
			<div
				data-tauri-drag-region
				className={cn(
					"flex h-11 shrink-0 items-center border-b border-border bg-surface/80 pr-6 backdrop-blur transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			>
				<span className="truncate text-sm font-medium text-fg" title={firstUserText || sessionTitle}>
					{sessionTitle}
				</span>
				{displayWorkspace && (
					<span className="ml-3 truncate font-mono text-xs text-muted/60" title={displayWorkspace}>
						{displayWorkspace}
					</span>
				)}
			</div>
			{/* 顶部 tab 栏 — 设计稿: 纯文字标签，激活态主色加粗 + 底部 34x4 短下划线。 */}
			<div
				className={cn(
					"flex h-12 shrink-0 items-stretch gap-8 border-b border-border bg-surface transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			>
				{chatTabs.map(({ id, label }) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						className={cn(
							"relative flex items-center text-base transition-colors",
							tab === id ? "font-semibold text-accent" : "text-muted hover:text-accent",
						)}
						title={label}
					>
						{label}
						{tab === id && (
							<span className="absolute bottom-0 left-1/2 h-1 w-[34px] -translate-x-1/2 bg-accent" />
						)}
					</button>
				))}
			</div>
			{/* 对话 tab 始终保持挂载（仅隐藏），避免切 tab 丢失输入草稿与滚动位置。 */}
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col",
					isEmpty && "justify-center",
					tab !== "conversation" && "hidden",
				)}
				style={
					isEmpty
						? { backgroundImage: "radial-gradient(ellipse 65% 40% at 50% 0%, var(--welcome-glow), transparent 72%)" }
						: undefined
				}
			>
				{/* 查看历史对话提示条:点侧栏旧行进入;发消息会先重开(带摘要),也可直接返回当前对话。 */}
				{viewingOld && (
					<div className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-6 pt-3">
						<div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-1.5 text-xs text-muted">
							<History className="h-3.5 w-3.5 shrink-0 text-accent" />
							<span className="truncate">{t("chat.viewingHistory")}</span>
						</div>
						<button
							type="button"
							onClick={onExitViewing}
							className="shrink-0 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-2/80"
						>
							{t("chat.backToCurrent")}
						</button>
					</div>
				)}
				<div ref={scrollRef} className={cn(isEmpty ? "flex-none" : "min-h-0 flex-1 overflow-y-auto")} style={{ overflowAnchor: "auto" }}>
					{isEmpty ? (
						<AgentIdentityCard
							workspace={displayWorkspace}
							status={
								switching
									? t("common.starting")
									: sidecarReady
										? t("chat.readyPrompt")
										: sidecarExitCode !== null
											? t("chat.sidecarExited", { code: sidecarExitCode })
											: t("common.starting")
							}
							tone={switching ? "neutral" : sidecarReady ? "success" : sidecarExitCode !== null ? "danger" : "neutral"}
						/>
					) : (
					<Conversation
						items={items}
						sidecarReady={sidecarReady}
						sidecarExitCode={sidecarExitCode}
						onResolveApproval={handleResolveApproval}
					/>
					)}
				</div>
				{error && (
					<div className="mx-auto max-w-3xl px-6 pb-2">
						<div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
							{error}
						</div>
					</div>
				)}
				{/* 定时任务悬浮卡片(高保真 36 画板):pinned 任务锚定到当前会话(或其分支)时显示 */}
				<TaskSessionCard sessionId={state?.sessionId ?? null} workspace={displayWorkspace} />
				<Composer
					state={state}
					workspace={displayWorkspace}
					sidecarReady={sidecarReady && !switching}
					isRunning={isRunning}
					onSend={handleSend}
					onAbort={handleAbort}
					onRefreshState={onRefreshState}
					/>
			</div>
			{/* 其余 tab 按需挂载（重新拉取数据），内容区整宽。查看历史对话时,
			    各 tab 跟随查看中的会话 —— 同一段对话的聊天/历史/时间线/回放
			    形成联动闭环,而不是各说各话。 */}
			{tab !== "conversation" && (
				<div className="min-h-0 flex-1 overflow-hidden">
					{tab === "history" ? (
						<BranchTreeExplorer workspace={workspace} focusSessionId={viewingSessionId ?? state?.sessionId ?? null} />
					) : tab === "timeline" ? (
						<EventTimeline workspace={workspace} sessionId={viewingSessionId ?? undefined} />
					) : tab === "status" ? (
						<ExecutionStatus workspace={workspace} />
					) : (
						<ReplayView sessionId={replaySessionId} />
					)}
				</div>
			)}
		</div>
	);
}
