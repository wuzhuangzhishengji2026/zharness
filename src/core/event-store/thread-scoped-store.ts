/**
 * ThreadScopedStore
 *
 * Wraps an EventStore to automatically tag every appended event with a
 * `thread_id`. This is the isolation mechanism for single-workspace
 * multi-thread: all threads share one SQLite event log, but each thread's
 * events are tagged, and SessionProjection.buildContext() filters by it.
 *
 * Read operations (query, get, subscribe, etc.) delegate to the inner store
 * unchanged — callers add `thread_id` to their own queries when needed.
 */

import type { EventBase } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";

export class ThreadScopedStore implements EventStore {
	/**
	 * threadId 可以是快照字符串,也可以是 getter —— 会话跳转/调度派发会切
	 * 活跃线程(见 SessionManager.switchTo/jumpToSession),包装层必须跟随
	 * 当时的活跃线程打标,否则事件会落进旧线程的视图。
	 */
	private readonly resolveThreadId: () => string | undefined;

	constructor(
		private readonly inner: EventStore,
		threadId: string | (() => string | undefined),
	) {
		this.resolveThreadId = typeof threadId === "function" ? threadId : () => threadId;
	}

	get workspace_id(): string {
		return this.inner.workspace_id;
	}

	append(event: EventAppendInput): EventBase {
		return this.inner.append({ ...event, thread_id: this.resolveThreadId() });
	}

	appendBatch(events: EventAppendInput[]): EventBase[] {
		const threadId = this.resolveThreadId();
		return this.inner.appendBatch(events.map((e) => ({ ...e, thread_id: threadId })));
	}

	query(filter: EventQuery): EventBase[] {
		return this.inner.query(filter);
	}

	get(event_id: string): EventBase | undefined {
		return this.inner.get(event_id);
	}

	latest(count: number): EventBase[] {
		return this.inner.latest(count);
	}

	getCausalChain(event_id: string): EventBase[] {
		return this.inner.getCausalChain(event_id);
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.inner.subscribe(handler, options);
	}

	get size(): number {
		return this.inner.size;
	}

	get head(): string | undefined {
		return this.inner.head;
	}

	get head_sequence(): number {
		return this.inner.head_sequence;
	}
}
