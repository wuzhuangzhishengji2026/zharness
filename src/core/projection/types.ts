/**
 * Session Projection Types
 *
 * Session is a query view over the EventStore, not a data holder.
 */

import type { EventBase } from "../event-store/types.js";

// ============================================================================
// Session Descriptor
// ============================================================================

/** Session definition - pure reference structure */
export interface SessionDescriptor {
	session_id: string;
	thread_id: string;
	workspace_id: string;
	/** Event range covered by this session [start, end] (inclusive) */
	event_range: {
		start_event_id: string;
		end_event_id: string; // "HEAD" = tracking latest
	};
	/**
	 * 继承段列表(历史前缀,按日志序):每段 (start_event_id 不含,
	 * end_event_id **含端点**)。分支视图 = 继承段 ∪ 主段
	 * (event_range.start_event_id 不含, end_event_id 不含/HEAD=开)。
	 *
	 * 单段区间时代,rewind/跳回靠「区间吞并」推导上下文 —— 新分支写成
	 * (start, HEAD] 会把源分支封口后同线程其它分支的事件全部吞进来;
	 * 写成 (rewind点, HEAD] 则丢掉全部历史(语义反了)。继承段把「带哪段
	 * 历史」变成显式声明:
	 *   - rewind(e):  活跃分支视面截断到 ≤e 作为继承段
	 *   - 跳回/无损 fork(S): S 的完整视面作为继承段
	 *   - 摘要 fork / 新对话: 无继承段(单段,现状不变)
	 * 连续 rewind(在 rewind 分支上再 rewind)会跨段截断,数组天然支持。
	 */
	inherited_ranges?: Array<{
		start_event_id: string;
		end_event_id: string;
	}>;
	/** Summary reference (compaction event_id) */
	summary_event_id?: string;
	/** User-defined name */
	name?: string;
	/** Creation method */
	created_by: "user_explicit" | "fork";
	/** Boundary inference reason */
	boundary_reason?: "intent_shift" | "file_drift" | "user_explicit";
	/** Parent session (fork source) */
	parent_session_id?: string;
	/** Creation timestamp */
	created_at: number;
}

// ============================================================================
// Thread Descriptor
// ============================================================================

/**
 * A conversation thread — the isolation unit.
 *
 * One thread = one `thread_id` on events. Threads are fixed once created;
 * session splitting happens at session level (within a thread), never at thread level.
 * A thread contains a tree of sessions (branches from rewind/fork).
 */
export interface ThreadDescriptor {
	thread_id: string;
	workspace_id: string;
	/** User-defined name (e.g. "Q3 marketing") */
	name?: string;
	/** Creation timestamp */
	created_at: number;
	/** Lifecycle status. active = ongoing; closed = user-ended. */
	status: "active" | "closed";
}

/** Session index storage (threads + their session branches) */
export interface SessionIndex {
	threads: ThreadDescriptor[];
	sessions: SessionDescriptor[];
	/**
	 * 持久化的活跃会话指针。重启(sidecar/GUI)后恢复到用户关闭前正在
	 * 看的对话,而不是按插入序猜「最后一个 open 会话」。
	 */
	active_session_id?: string;
}

// ============================================================================
// Build Context
// ============================================================================

/** Options for building LLM context */
export interface BuildContextOptions {
	/** Token budget */
	max_tokens?: number;
	/** Include tool execution details */
	include_tool_details?: boolean;
	/** Include file mutations */
	include_file_mutations?: boolean;
}

/** Built context result */
export interface BuiltContext {
	/** Messages for LLM consumption */
	messages: import("../agent/types.js").AgentMessage[];
	/**
	 * Source event id per message (parallel to `messages`), when available.
	 * Lets context transformers (e.g. the context-editor extension) target a
	 * message stably across turns instead of matching by content.
	 * Entries may be undefined for synthesized messages.
	 */
	sourceEventIds?: (string | undefined)[];
	/** Raw events used to build context */
	events: EventBase[];
	/** Session descriptor */
	descriptor: SessionDescriptor;
}

