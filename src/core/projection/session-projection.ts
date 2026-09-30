/**
 * Session Projection
 *
 * Session is a query view over EventStore, not a data holder.
 * Builds LLM context from event queries.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, EventType } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import { isCompactionBoundary } from "../event-store/events.js";
import type { SessionDescriptor, BuildContextOptions, BuiltContext } from "./types.js";
import type { TimelineEntry, TimelineEntryKind } from "./timeline-projection.js";
import { eventToMessage } from "./event-to-message.js";

// ============================================================================
// Constants
// ============================================================================

/** Event types that participate in LLM context */
export const CONTEXT_RELEVANT_EVENT_TYPES: EventType[] = [
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"TOOL_EXECUTION_END",
	"COMPACTION_END",
	"FILE_MUTATION_APPLIED",
	"BASH_EXECUTION",
	"CUSTOM_MESSAGE",
	"BRANCH_SUMMARY",
];

// ============================================================================
// Session Projection
// ============================================================================

/**
 * SessionProjection builds LLM context from EventStore queries.
 *
 * Session is a projection/view over events, not a data holder.
 * Multiple sessions can coexist - same events can belong to multiple session views.
 */
export class SessionProjection {
	constructor(
		private store: EventStore,
		private descriptor: SessionDescriptor,
	) {}

	/**
	 * Build LLM-usable context message list.
	 *
	 * Logic:
	 * 1. Query all context-relevant events from event_range
	 * 2. If summary_event_id exists, inject compaction summary first
	 * 3. Convert events to AgentMessage[] format
	 * 4. Apply token budget truncation if needed
	 */
	buildContext(options?: BuildContextOptions): BuiltContext {
		const events = this._applyCompactionBoundary(this.getSessionEvents(CONTEXT_RELEVANT_EVENT_TYPES));

		// Build (message, sourceEventId) pairs so context consumers can address
		// messages stably across turns. `eventsToMessages` skips events that
		// produce no message, so the zip must go through eventToMessage too.
		let pairs: { message: AgentMessage; eventId: string | undefined }[] = [];
		for (const event of events) {
			const msg = eventToMessage(event);
			if (msg) pairs.push({ message: msg, eventId: event.event_id });
		}

		// 丢弃孤儿 toolResult:回合中发生会话跳转(jump/fork,agent 自己调
		// _history_tree 也会)后,新会话区间只含工具结果,发出 toolCall 的
		// assistant 消息留在旧会话区间 —— 服务商对没有匹配 tool_call 的
		// tool 消息直接 400,重试只会把更多错误消息累积进上下文。
		const toolCallIds = new Set<string>();
		for (const { message } of pairs) {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; id?: unknown }>) {
				if (block && block.type === "toolCall" && typeof block.id === "string") {
					toolCallIds.add(block.id);
				}
			}
		}
		pairs = pairs.filter(({ message }) => {
			if ((message as { role?: string }).role !== "toolResult") return true;
			const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
			return typeof toolCallId !== "string" || toolCallIds.has(toolCallId);
		});

		// Inject compaction summary if present
		if (this.descriptor.summary_event_id) {
			const summaryAlreadyInRange = events.some((event) => event.event_id === this.descriptor.summary_event_id);
			const summaryEvent = this.store.get(this.descriptor.summary_event_id);
			if (!summaryAlreadyInRange && summaryEvent && isCompactionBoundary(summaryEvent)) {
				const summaryPayload = summaryEvent.payload as {
					summary: string;
					tokens_before: number;
				};
				// Use compactionSummary message type
				pairs.unshift({
					message: {
						role: "compactionSummary",
						summary: summaryPayload.summary,
						tokensBefore: summaryPayload.tokens_before,
						timestamp: summaryEvent.timestamp,
					} as AgentMessage,
					eventId: this.descriptor.summary_event_id,
				});
			}
		}

		// Apply token budget if specified
		if (options?.max_tokens) {
			pairs = this._truncateByTokens(pairs, options.max_tokens);
		}

		return {
			messages: pairs.map((p) => p.message),
			sourceEventIds: pairs.map((p) => p.eventId),
			events,
			descriptor: this.descriptor,
		};
	}

	/**
	 * Get timeline view for UI display.
	 *
	 * Returns all events visible to this session (inherited segments ∪ main
	 * segment), ordered by time.
	 */
	getTimeline(): TimelineEntry[] {
		const events = this.getSessionEvents();

		return events.map((e) => ({
			event_id: e.event_id,
			kind: this._eventTypeToKind(e.type),
			actor_id: e.actor_id,
			timestamp: e.timestamp,
			summary: this._summarizeEvent(e),
			caused_by: e.caused_by,
		}));
	}

	/**
	 * 本分支可见的全部事件:继承段 ∪ 主段,按日志序(sequence)升序、按线程
	 * 过滤。buildContext / getTimeline / 查看模式取数共用这一份投影。
	 */
	getSessionEvents(types?: EventType[]): EventBase[] {
		const threadId = this.descriptor.thread_id;
		const seen = new Set<string>();
		const collected: EventBase[] = [];
		const push = (events: EventBase[]): void => {
			for (const event of events) {
				if (event.thread_id && event.thread_id !== threadId) continue;
				if (seen.has(event.event_id)) continue;
				seen.add(event.event_id);
				collected.push(event);
			}
		};

		// 继承段:每段 (start 不含, end 含端点)。sequence 比较:
		// seq > seq(start) 且 seq < seq(end)+1。
		for (const segment of this.descriptor.inherited_ranges ?? []) {
			const startEvent =
				segment.start_event_id === "ORIGIN" ? undefined : this.store.get(segment.start_event_id);
			const endEvent =
				segment.end_event_id === "HEAD" ? undefined : this.store.get(segment.end_event_id);
			if (!startEvent && !endEvent && segment.end_event_id !== "HEAD") continue;
			const filter: {
				after_sequence?: number;
				before_sequence?: number;
				types?: EventType[];
			} = {};
			if (startEvent) filter.after_sequence = startEvent.sequence;
			if (endEvent) filter.before_sequence = endEvent.sequence + 1;
			if (types?.length) filter.types = types;
			push(this.store.query(filter));
		}

		// 主段:(start 不含, end 不含 / HEAD=开上界)。
		const { start, end } = this._getEventRange();
		const mainFilter: { after?: string; before?: string; types?: EventType[] } = {};
		if (start) mainFilter.after = start;
		if (end) mainFilter.before = end;
		if (types?.length) mainFilter.types = types;
		push(this.store.query(mainFilter));

		collected.sort((a, b) => a.sequence - b.sequence);
		return collected;
	}

	/**
	 * Get the session descriptor.
	 */
	getDescriptor(): SessionDescriptor {
		return this.descriptor;
	}

	/**
	 * Update the session descriptor.
	 */
	updateDescriptor(updates: Partial<SessionDescriptor>): void {
		Object.assign(this.descriptor, updates);
	}

	/**
	 * Get effective start event_id (ORIGIN if not set).
	 */
	getEffectiveStart(): string {
		return this.descriptor.event_range.start_event_id;
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _getEventRange(): { start: string | undefined; end: string | undefined } {
		const start = this.descriptor.event_range.start_event_id === "ORIGIN" ? undefined : this.descriptor.event_range.start_event_id;
		const end = this.descriptor.event_range.end_event_id === "HEAD" ? undefined : this.descriptor.event_range.end_event_id;
		return { start, end };
	}

	private _applyCompactionBoundary(events: EventBase[]): EventBase[] {
		// Only a real boundary (non-empty first_kept_event_id) may trim history:
		// failed compactions recorded a COMPACTION_END with an empty id, and
		// treating it as a boundary dropped every event before it — the whole
		// conversation collapsed into a "Compaction failed: …" stub.
		let latestCompaction: EventBase | undefined;
		for (const event of events) {
			if (isCompactionBoundary(event)) {
				latestCompaction = event;
			}
		}
		if (!latestCompaction) {
			// Drop failed compaction markers: they carry no usable summary and
			// would render as empty summary messages mid-conversation.
			return events.filter((event) => event.type !== "COMPACTION_END");
		}

		const payload = latestCompaction.payload as { first_kept_event_id?: string };
		const firstKept = payload.first_kept_event_id ? this.store.get(payload.first_kept_event_id) : undefined;
		const firstKeptSequence = firstKept?.sequence ?? latestCompaction.sequence + 1;

		return [
			latestCompaction,
			...events.filter((event) => event.type !== "COMPACTION_END" && event.sequence >= firstKeptSequence),
		];
	}

	private _summarizeEvent(event: EventBase): string {
		switch (event.type) {
			case "USER_MESSAGE": {
				const payload = event.payload as { content: string | unknown[] };
				const content = typeof payload.content === "string" ? payload.content : "[Content]";
				return `User: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
			}

			case "AGENT_MESSAGE_END": {
				const payload = event.payload as { stop_reason: string };
				return `Agent (stop: ${payload.stop_reason})`;
			}

			case "TOOL_EXECUTION_END": {
				const payload = event.payload as { tool_name: string; is_error: boolean };
				return `${payload.is_error ? "❌" : "✓"} ${payload.tool_name}`;
			}

			case "COMPACTION_END":
				return "📋 Compaction summary applied";

			case "SESSION_CREATED": {
				const payload = event.payload as { name?: string; created_by: string };
				return `Session created: ${payload.name ?? payload.created_by}`;
			}

			case "SESSION_FORKED": {
				const payload = event.payload as { new_session_id: string };
				return `Forked to new session`;
			}

			default:
				return event.type;
		}
	}

	private _truncateByTokens(
		pairs: { message: AgentMessage; eventId: string | undefined }[],
		maxTokens: number,
	): { message: AgentMessage; eventId: string | undefined }[] {
		// Simple truncation: keep recent messages up to token limit
		// In production, use proper token counting
		const estimatedTokensPerMessage = 100; // rough estimate
		const maxMessages = Math.floor(maxTokens / estimatedTokensPerMessage);

		if (pairs.length <= maxMessages) {
			return pairs;
		}

		// Keep system-equivalent messages + most recent messages
		const systemPairs = pairs.filter(
			(p) => p.message.role === "compactionSummary" || p.message.role === "branchSummary",
		);
		const otherPairs = pairs.filter(
			(p) => p.message.role !== "compactionSummary" && p.message.role !== "branchSummary",
		);

		const recentPairs = otherPairs.slice(-maxMessages);
		return [...systemPairs, ...recentPairs];
	}

	private _eventTypeToKind(type: EventType): TimelineEntryKind {
		switch (type) {
			case "USER_MESSAGE":
				return "user_message";
			case "AGENT_MESSAGE_START":
			case "AGENT_MESSAGE_CHUNK":
			case "AGENT_MESSAGE_END":
				return "agent_message";
			case "TOOL_EXECUTION_START":
			case "TOOL_EXECUTION_UPDATE":
			case "TOOL_EXECUTION_END":
				return "tool_execution";
			case "FILE_MUTATION_APPLIED":
				return "file_mutation";
			case "GOAL_CREATED":
			case "GOAL_CLASSIFIED":
			case "GOAL_PLANNED":
			case "GOAL_PAUSED":
			case "GOAL_RESUMED":
			case "GOAL_COMPLETED":
			case "GOAL_CANCELLED":
				return "goal_event";
			case "TASK_CREATED":
			case "TASK_ASSIGNED":
			case "TASK_STARTED":
			case "TASK_PROGRESS":
			case "TASK_COMPLETED":
			case "TASK_FAILED":
			case "TASK_REWORK_REQUESTED":
			case "TASK_ACCEPTED":
			case "TASK_CANCELLED":
				return "task_event";
			case "SESSION_CREATED":
			case "SESSION_BOUNDARY_INFERRED":
			case "SESSION_FORKED":
				return "session_boundary";
			case "COMPACTION_REQUESTED":
			case "COMPACTION_START":
			case "COMPACTION_END":
			case "COMPACTION_ABORTED":
				return "compaction";
			case "AGENT_ERROR":
			case "RUNTIME_ERROR":
				return "error";
			case "CHECKPOINT_CREATED":
			case "CHECKPOINT_RESTORED":
			case "CHECKPOINT_FAILED":
				return "checkpoint";
			default:
				return "agent_message";
		}
	}
}
