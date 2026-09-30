/**
 * Session Manager (v2: per-session event stores)
 *
 * 旧版（v1）：全工作区共享一条事件日志，会话 = 日志上的可变区间
 * (start, end=HEAD]，需要封口不变量、悬挂修复、多段投影——整类区间数学
 * 已随共享日志一并删除。
 *
 * v2：一个会话一个自包含事件库（SessionFileStoreManager），会话即日志
 * 本身。本类只剩三件事：header ↔ SessionDescriptor 的映射、活跃指针、
 * fork/rewind/jump 的语义操作（复制前缀 / 切指针）。保留旧公开 API 壳，
 * runtime/facade/extensions/rpc 的既有接线零改动。
 */

import type { EventStore } from "../event-store/store.js";
import { SessionFileStoreManager, type CreateSessionFileOptions } from "../event-store/session-files.js";
import type { SessionDescriptor, ThreadDescriptor } from "./types.js";
import { SessionProjection } from "./session-projection.js";

export interface CreateProjectionSessionOptions {
	parentSessionId?: string;
	/** 兼容占位：每会话一库后 thread 即会话，传入值被忽略。 */
	threadId?: string;
	/** 兼容占位：仅作为 fork_at 信息记录在 header，不再承担区间语义。 */
	startEventId?: string;
	summaryEventId?: string;
	closeActive?: boolean;
}

export class SessionManager {
	constructor(
		readonly files: SessionFileStoreManager,
		/** 兼容占位：v1 的 sessionStore 参数不再使用。 */
		_legacySessionStore?: unknown,
	) {
		void _legacySessionStore;
	}

	// =========================================================================
	// Descriptor mapping（header ↔ SessionDescriptor）
	// =========================================================================

	private descriptorOf(sessionId: string): SessionDescriptor | undefined {
		const header = this.files.getHeader(sessionId);
		if (!header) return undefined;
		return {
			session_id: header.session_id,
			thread_id: header.session_id,
			workspace_id: header.workspace_id,
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			summary_event_id: header.summary_event_id,
			name: header.title,
			created_by: header.created_by,
			parent_session_id: header.parent_session_id,
			created_at: header.created_at,
		};
	}

	// =========================================================================
	// Session Operations
	// =========================================================================

	getActiveSession(): SessionProjection {
		// 惰性建会话（v1 语义）：空工作区第一次访问活跃会话时才创建。
		if (!this.files.activeSessionId) {
			this.files.createSession({ created_by: "user_explicit" });
		}
		const id = this.files.activeSessionId!;
		const descriptor = this.descriptorOf(id)!;
		return new SessionProjection(this.files.openStore(id), descriptor);
	}

	createSession(
		created_by: SessionDescriptor["created_by"],
		name?: string,
		options: CreateProjectionSessionOptions = {},
	): SessionDescriptor {
		const fileOptions: CreateSessionFileOptions = {
			name,
			created_by,
			parentSessionId: options.parentSessionId,
			forkAtEventId: options.startEventId,
			summaryEventId: options.summaryEventId,
		};
		const header = this.files.createSession(fileOptions);
		return this.descriptorOf(header.session_id)!;
	}

	/**
	 * Rewind（回到某事件继续）：活跃库 ≤event 的前缀复制进新库并切换。
	 * 旧库原样保留 —— "封口"概念不存在。
	 */
	forkAt(event_id: string): SessionDescriptor {
		const header = this.files.forkAtFromActive(event_id);
		return this.descriptorOf(header.session_id)!;
	}

	/** 从既有会话派生新分支（preserveHistory=false 起空库，谱系经 parent 指针记录）。 */
	forkFromSession(session_id: string, options?: { preserveHistory?: boolean }): SessionDescriptor {
		const header = this.files.forkFrom(session_id, { preserveHistory: options?.preserveHistory });
		return this.descriptorOf(header.session_id)!;
	}

	/**
	 * Jump（继续一段旧对话）：直接把该会话的库切回活跃位继续追加 ——
	 * 文件自包含，无需复制、无需重开。
	 */
	jumpToSession(session_id: string, reason?: string): { descriptor: SessionDescriptor; reopened: boolean } {
		const descriptor = this.descriptorOf(session_id);
		if (!descriptor) throw new Error(`Session not found: ${session_id}`);
		if (session_id === this.files.activeSessionId) {
			return { descriptor, reopened: false };
		}
		this.files.setActive(session_id);
		// 重开信号：前端 ChatView 靠 SESSION_JUMPED 重载时间线，reactor 靠它
		// 在回合中重指向活跃会话投影。no-op 跳转（目标即活跃）不发。
		this.files.emitSessionJumped(session_id, reason);
		return { descriptor, reopened: true };
	}

	listSessions(): SessionDescriptor[] {
		return this.files
			.listSessions()
			.map((header) => this.descriptorOf(header.session_id))
			.filter((descriptor): descriptor is SessionDescriptor => descriptor !== undefined);
	}

	switchTo(session_id: string): void {
		if (!this.files.getHeader(session_id)) {
			throw new Error(`Session not found: ${session_id}`);
		}
		this.files.setActive(session_id);
	}

	getSession(session_id: string): SessionDescriptor | undefined {
		return this.descriptorOf(session_id);
	}

	getSessionProjection(session_id: string): SessionProjection | undefined {
		const descriptor = this.descriptorOf(session_id);
		if (!descriptor) return undefined;
		return new SessionProjection(this.files.openStore(session_id), descriptor);
	}

	renameSession(session_id: string, name: string): void {
		this.files.rename(session_id, name);
	}

	getActiveSessionId(): string | undefined {
		return this.files.activeSessionId;
	}

	/** thread shim：thread_id === 活跃会话 id。 */
	getActiveThreadId(): string | undefined {
		return this.files.activeSessionId;
	}

	getActiveThread(): ThreadDescriptor | undefined {
		const id = this.files.activeSessionId;
		return id ? this.files.threadShim(id) : undefined;
	}

	/** thread shim：新建一个会话文件（新对话 = 新会话），返回其 thread 描述。 */
	createThread(name?: string, options: Omit<CreateProjectionSessionOptions, "threadId"> = {}): ThreadDescriptor {
		const descriptor = this.createSession("user_explicit", name, options);
		return this.files.threadShim(descriptor.session_id);
	}

	/** 话题切分：活跃库尾部（含触发切分的用户消息）搬进新库，旧库截断。 */
	splitTailFrom(sequence: number, name?: string, kind?: "scheduled"): SessionDescriptor {
		const header = this.files.splitTailFrom(sequence, { name, kind });
		return this.descriptorOf(header.session_id)!;
	}

	/** 活跃会话是否为空壳（new_session 幂等守卫用）。 */
	isActiveEmpty(): boolean {
		return this.files.isActiveEmpty();
	}

	/** 兼容占位：v1 消费方偶-read 的字段；每会话一库后无独立 EventStore。 */
	get store(): EventStore {
		return this.files.active;
	}

	dispose(): void {
		this.files.dispose();
	}
}
