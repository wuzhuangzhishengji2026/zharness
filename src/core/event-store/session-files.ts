/**
 * Per-session event stores (v2 分账模型)
 *
 * 一个会话 = 一个自包含的 SQLite 事件库 + 旁边的 header.json：
 *
 *   <workspace>/sessions/<sessionId>/events.sqlite   事件日志（仅本会话）
 *   <workspace>/sessions/<sessionId>/header.json     元数据 + 标题
 *   <workspace>/sessions/active.json                 活跃会话指针
 *
 * 设计对齐 dsh/pi 的"物理分账"：会话即日志本身，fork/rewind = 把前缀行
 * 复制进新库（appendBatch 保序保 id），jump = 切换活跃指针继续追加原文件。
 * 没有共享日志、没有区间 (start,end]、没有 HEAD 哨兵、没有封口不变量 ——
 * 旧模型的一切区间数学在此不存在。
 *
 * 旧工作区大库由 ensureMigrated() 幂等迁移；旧库文件原样保留。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "./sqlite-store.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";
import type { EventBase } from "./types.js";
import type { ThreadDescriptor } from "../projection/types.js";
import { SessionProjection } from "../projection/session-projection.js";
import type { HistoryTreeNodeInfo } from "../projection/history-tree.js";
import { getAgentDir } from "../../config.js";
import { getEventDatabasePath } from "./workspace.js";

// ============================================================================
// Header
// ============================================================================

export interface SessionFileHeader {
	version: 1;
	session_id: string;
	workspace_id: string;
	created_at: number;
	/** 显示标题：首条用户消息或用户命名；存盘，不再现场探测。 */
	title?: string;
	cwd?: string;
	created_by: "user_explicit" | "fork";
	/** fork/rewind 来源会话（谱系指针，建树用）。 */
	parent_session_id?: string;
	/** 本会话从父会话的哪个事件分叉（信息性，建树用）。 */
	fork_at_event_id?: string;
	/** 脚手架会话标记（定时任务等），侧栏跳过。 */
	kind?: "scheduled";
	/** v1 迁移遗留的压缩摘要引用（源库内 id，信息性）。新 fork 不再携带 ——
	 * 每会话一库后空分支里永远查不到源库的摘要事件。 */
	summary_event_id?: string;
}

const HEADER_FILE = "header.json";
const DB_FILE = "events.sqlite";
const ACTIVE_FILE = "active.json";
const MIGRATED_MARKER = ".migrated-v2";

function readHeader(sessionDir: string): SessionFileHeader | undefined {
	try {
		return JSON.parse(readFileSync(join(sessionDir, HEADER_FILE), "utf8")) as SessionFileHeader;
	} catch {
		return undefined;
	}
}

function writeHeaderFile(sessionDir: string, header: SessionFileHeader): void {
	writeFileSync(join(sessionDir, HEADER_FILE), JSON.stringify(header, null, 2));
}

// ============================================================================
// Active-session store proxy（活跃会话代理）
// ============================================================================

/**
 * EventStore 代理：把一切读写路由到"当前活跃会话"的库。runtime/facade 持有
 * 这个代理即持有全部会话 —— 切换会话只是 _setTarget 换目标，既有 store 接线
 * （reactor、事件转发、compaction）零改动。
 *
 * 订阅经代理自己的 fan-out 转发：底层库切换后，代理级订阅者继续收到新
 * 会话的事件，不会绑死在旧库的 emitter 上。
 */
export class ActiveSessionStore implements EventStore {
	private target: SqliteEventStore | undefined;
	private targetUnsubscribe: (() => void) | undefined;
	private listeners = new Map<number, { handler: (event: EventBase) => void; options?: SubscribeOptions }>();
	private nextSubId = 0;

	constructor(
		readonly workspace_id: string,
		private readonly manager: SessionFileStoreManager,
	) {}

	/** 切换目标库（换活跃会话）。旧句柄留在 manager 缓存里供回看。 */
	_setTarget(store: SqliteEventStore): void {
		if (this.target === store) return;
		if (this.targetUnsubscribe) this.targetUnsubscribe();
		this.target = store;
		this.targetUnsubscribe = store.subscribe((event) => {
			for (const { handler, options } of this.listeners.values()) {
				if (options?.types && !options.types.includes(event.type)) continue;
				try {
					handler(event);
				} catch {
					/* 订阅者异常不阻断转发 */
				}
			}
		});
	}

	_requireTarget(): SqliteEventStore {
		if (!this.target) throw new Error("No active session store — create or switch to a session first");
		return this.target;
	}

	append(event: EventAppendInput): EventBase {
		if (event.type === "USER_MESSAGE") this.manager.noteUserMessage(event.payload);
		return this._requireTarget().append(event);
	}

	appendBatch(events: EventAppendInput[]): EventBase[] {
		for (const event of events) {
			if (event.type === "USER_MESSAGE") this.manager.noteUserMessage(event.payload);
		}
		return this._requireTarget().appendBatch(events);
	}

	query(filter: EventQuery): EventBase[] {
		return this._requireTarget().query(filter);
	}

	get(event_id: string): EventBase | undefined {
		return this._requireTarget().get(event_id);
	}

	latest(count: number): EventBase[] {
		return this._requireTarget().latest(count);
	}

	getCausalChain(event_id: string): EventBase[] {
		return this._requireTarget().getCausalChain(event_id);
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		const id = ++this.nextSubId;
		this.listeners.set(id, { handler, options });
		return () => {
			this.listeners.delete(id);
		};
	}

	get size(): number {
		return this._requireTarget().size;
	}

	get head(): string | undefined {
		return this.target?.head;
	}

	get head_sequence(): number {
		return this.target?.head_sequence ?? 0;
	}

	retagThreadFrom(): void {
		// 每会话一库后无跨会话重打标；旧接口保留为 no-op。
	}
}

// ============================================================================
// Manager
// ============================================================================

export interface CreateSessionFileOptions {
	name?: string;
	created_by?: SessionFileHeader["created_by"];
	parentSessionId?: string;
	forkAtEventId?: string;
	kind?: SessionFileHeader["kind"];
	summaryEventId?: string;
	cwd?: string;
}

export class SessionFileStoreManager {
	readonly root: string;
	readonly active: ActiveSessionStore;
	private readonly memory: boolean;
	private readonly memoryStores = new Map<string, SqliteEventStore>();
	private readonly memoryHeaders = new Map<string, SessionFileHeader>();
	private readonly storeCache = new Map<string, SqliteEventStore>();
	private _activeSessionId: string | undefined;
	private nextMemoryId = 0;

	constructor(
		readonly workspace_id: string,
		agentDir?: string,
		options: { cwd?: string; storagePath?: string } = {},
	) {
		this.memory = options.storagePath === ":memory:";
		if (this.memory) {
			this.root = ":memory:";
		} else {
			this.root = join(dirname(getEventDatabasePath(workspace_id, agentDir ?? getAgentDir())), "sessions");
			mkdirSync(this.root, { recursive: true });
		}
		this.active = new ActiveSessionStore(workspace_id, this);
		this.ensureMigrated(agentDir ?? getAgentDir(), options.cwd);
		this.restoreActivePointer(options.cwd);
	}

	// ── 布局与句柄 ──────────────────────────────────────────────────────────

	private sessionDir(id: string): string {
		return join(this.root, id);
	}

	private newSessionId(): string {
		if (this.memory) return `sess_mem_${Date.now().toString(36)}_${this.nextMemoryId++}`;
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}

	/** 打开（并缓存）某会话自己的事件库。 */
	openStore(sessionId: string): SqliteEventStore {
		const cached = this.storeCache.get(sessionId);
		if (cached) return cached;
		if (this.memory) {
			const mem = this.memoryStores.get(sessionId);
			if (mem) return mem;
			throw new Error(`Session store not found: ${sessionId}`);
		}
		const dbPath = join(this.sessionDir(sessionId), DB_FILE);
		if (!existsSync(dbPath)) {
			throw new Error(`Session store not found: ${sessionId}`);
		}
		const store = new SqliteEventStore(this.workspace_id, dbPath, "session_file_runtime");
		this.storeCache.set(sessionId, store);
		return store;
	}

	private createStore(sessionId: string): SqliteEventStore {
		if (this.memory) {
			const store = new SqliteEventStore(this.workspace_id, ":memory:", "session_file_runtime");
			this.memoryStores.set(sessionId, store);
			return store;
		}
		// 新建（区别于 openStore 的"必须已存在"）：SqliteEventStore 会建目录。
		const store = new SqliteEventStore(this.workspace_id, join(this.sessionDir(sessionId), DB_FILE), "session_file_runtime");
		this.storeCache.set(sessionId, store);
		return store;
	}

	// ── Header 读写 ─────────────────────────────────────────────────────────

	getHeader(sessionId: string): SessionFileHeader | undefined {
		if (this.memory) return this.memoryHeaders.get(sessionId);
		if (!sessionId || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\")) return undefined;
		const dir = this.sessionDir(sessionId);
		if (!existsSync(dir)) return undefined;
		return readHeader(dir);
	}

	private saveHeader(header: SessionFileHeader): void {
		if (this.memory) {
			this.memoryHeaders.set(header.session_id, header);
			return;
		}
		writeHeaderFile(this.sessionDir(header.session_id), header);
	}

	listSessions(): SessionFileHeader[] {
		if (this.memory) {
			return [...this.memoryHeaders.values()].sort((a, b) => b.created_at - a.created_at);
		}
		if (!existsSync(this.root)) return [];
		const headers: SessionFileHeader[] = [];
		for (const entry of readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const header = readHeader(join(this.root, entry.name));
			if (header) headers.push(header);
		}
		return headers.sort((a, b) => b.created_at - a.created_at);
	}

	// ── 会话创建（内部：显式 id，不切活跃位） ────────────────────────────────

	private createSessionInternal(id: string, options: CreateSessionFileOptions): SessionFileHeader {
		const header: SessionFileHeader = {
			version: 1,
			session_id: id,
			workspace_id: this.workspace_id,
			created_at: Date.now(),
			title: options.name,
			cwd: options.cwd,
			created_by: options.created_by ?? "user_explicit",
			parent_session_id: options.parentSessionId,
			fork_at_event_id: options.forkAtEventId,
			kind: options.kind,
			summary_event_id: options.summaryEventId,
		};
		// 先建库（SqliteEventStore 会建目录）再写 header，目录一定存在。
		this.createStore(id);
		this.saveHeader(header);
		return header;
	}

	createSession(options: CreateSessionFileOptions = {}): SessionFileHeader {
		const header = this.createSessionInternal(this.newSessionId(), options);
		this.setActive(header.session_id);
		// v1 语义：显式新建（new_session/懒创建）发 SESSION_CREATED。发在切
		// 指针之后，经活跃代理 append —— 落在新库尾部并扇出给订阅者
		// （reactor / facade → rpc → 前端 ChatView 的时间线重载靠它）。
		this.appendLifecycle("SESSION_CREATED", {
			session_id: header.session_id,
			name: options.name,
			created_by: header.created_by,
		});
		return header;
	}

	/**
	 * 追加一条会话生命周期事件（SESSION_CREATED/FORKED/JUMPED）到当前活跃
	 * 库并经代理扇出。失败不阻断会话操作本身。
	 */
	private appendLifecycle(
		type: "SESSION_CREATED" | "SESSION_FORKED" | "SESSION_JUMPED",
		payload: Record<string, unknown>,
	): void {
		try {
			this.active.append({ actor_id: "runtime", type, payload });
		} catch {
			/* 生命周期事件落库失败不阻断会话切换 */
		}
	}

	/** 历史 jump/重开信号：前端 ChatView 与 reactor 据此重载/重指向。 */
	emitSessionJumped(targetSessionId: string, reason?: string): void {
		this.appendLifecycle("SESSION_JUMPED", { target_session_id: targetSessionId, reason });
	}

	/**
	 * 新建一个空的 fork 目标库并切为活跃（不发 SESSION_CREATED）。跨工作区
	 * fork 用：随后整库导入源事件（保留原 sequence），导入完成后再发
	 * SESSION_FORKED —— 先发会占掉低位 sequence，与导入行撞 UNIQUE 约束。
	 */
	createForkSession(options: CreateSessionFileOptions = {}): SessionFileHeader {
		const header = this.createSessionInternal(this.newSessionId(), {
			...options,
			created_by: "fork",
		});
		this.setActive(header.session_id);
		return header;
	}

	/** fork 落地信号（跨工作区 fork 导入完成后由调用方发；工作区内 fork
	 * 由 forkFrom/forkAtFromActive 自己发）。 */
	emitSessionForked(payload: {
		new_session_id: string;
		parent_session_id?: string;
		fork_at_event_id: string;
	}): void {
		this.appendLifecycle("SESSION_FORKED", payload);
	}

	// ── 活跃指针 ────────────────────────────────────────────────────────────

	get activeSessionId(): string | undefined {
		return this._activeSessionId;
	}

	setActive(sessionId: string): void {
		const header = this.getHeader(sessionId);
		if (!header) throw new Error(`Session not found: ${sessionId}`);
		this._activeSessionId = sessionId;
		this.active._setTarget(this.openStore(sessionId));
		if (!this.memory) {
			try {
				writeFileSync(join(this.root, ACTIVE_FILE), JSON.stringify({ active_session_id: sessionId }));
			} catch {
				/* 指针写失败不阻断会话切换 */
			}
		}
	}

	private restoreActivePointer(cwd?: string): void {
		void cwd;
		const sessions = this.listSessions();
		// 空工作区不自动建会话：与 v1 的惰性语义一致（首个会话由
		// SessionManager.getActiveSession() 在真正需要时创建），否则跨项目
		// fork / 纯列举会在目标工作区留下空会话。
		if (sessions.length === 0) return;
		let pointer: string | undefined;
		if (!this.memory && existsSync(join(this.root, ACTIVE_FILE))) {
			try {
				pointer = (JSON.parse(readFileSync(join(this.root, ACTIVE_FILE), "utf8")) as { active_session_id?: string })
					.active_session_id;
			} catch {
				/* 损坏指针按缺失处理 */
			}
		}
		this.setActive(pointer && sessions.some((s) => s.session_id === pointer) ? pointer : sessions[0]!.session_id);
	}

	// ── 会话操作 ────────────────────────────────────────────────────────────

	/**
	 * Rewind（回到某事件继续）：把活跃库 ≤event 的前缀行复制进新库，新库
	 * 成为活跃会话。旧库原样保留（旧尾巴可随时查看）—— 没有封口，文件即
	 * 事实。
	 */
	forkAtFromActive(eventId: string): SessionFileHeader {
		const sourceId = this.activeSessionId;
		if (!sourceId) throw new Error("No active session to rewind");
		const source = this.openStore(sourceId);
		const cut = source.get(eventId);
		if (!cut) throw new Error(`Event not found: ${eventId}`);
		const prefix = source.query({ before_sequence: cut.sequence + 1 });
		// fork/split 走 createSessionInternal（不发 SESSION_CREATED）：前缀复制
		// 保留原 sequence，先发事件会占掉低位 sequence 与复制行冲突。v1 语义
		// 也是 fork 只发 SESSION_FORKED。
		const header = this.createSessionInternal(this.newSessionId(), {
			created_by: "fork",
			parentSessionId: sourceId,
			forkAtEventId: eventId,
		});
		this.setActive(header.session_id);
		this.copyEvents(this.openStore(header.session_id), prefix);
		// 复制（保序保 sequence）之后才发 FORKED —— 落在新库尾部。
		this.appendLifecycle("SESSION_FORKED", {
			new_session_id: header.session_id,
			parent_session_id: sourceId,
			fork_at_event_id: eventId,
		});
		return header;
	}

	/**
	 * 从既有会话派生新分支。preserveHistory=true 复制其完整日志（无损）；
	 * false 起空库。v2 每会话一库后不再携带源的 summary_event_id —— 空库
	 * 里 store.get 永远查不到源库的摘要事件，携带只是悬空引用（迁移数据
	 * header 上的旧字段保留，信息性）。
	 */
	forkFrom(sessionId: string, options: { preserveHistory?: boolean; name?: string } = {}): SessionFileHeader {
		const header = this.getHeader(sessionId);
		if (!header) throw new Error(`Session not found: ${sessionId}`);
		const preserveHistory = options.preserveHistory ?? true;
		const created = this.createSessionInternal(this.newSessionId(), {
			name: options.name ?? header.title,
			created_by: "fork",
			parentSessionId: sessionId,
		});
		this.setActive(created.session_id);
		if (preserveHistory) {
			const source = this.openStore(sessionId);
			this.copyEvents(this.openStore(created.session_id), source.query({}));
		}
		// fork_at 取源库当前头事件（v1：HEAD 跟踪者取实际头；空库退化 ORIGIN）。
		this.appendLifecycle("SESSION_FORKED", {
			new_session_id: created.session_id,
			parent_session_id: sessionId,
			fork_at_event_id: this.openStore(sessionId).head ?? "ORIGIN",
		});
		return created;
	}

	/**
	 * 话题切分（_session_split）：把活跃库 sequence 起的尾部行搬进新库，
	 * 旧库截断 —— 每个文件保持自洽，新会话带着触发切分的用户请求继续。
	 */
	splitTailFrom(sequence: number, options: CreateSessionFileOptions = {}): SessionFileHeader {
		const sourceId = this.activeSessionId;
		if (!sourceId) throw new Error("No active session to split");
		const source = this.openStore(sourceId);
		const tail = source.query({ after_sequence: sequence - 1 });
		// 切分不发 CREATED/FORKED：话题切分的信号是扩展随后追加的
		// SESSION_BOUNDARY_INFERRED（经代理落入本新库并扇出）。
		const header = this.createSessionInternal(this.newSessionId(), {
			name: options.name,
			created_by: "fork",
			parentSessionId: sourceId,
			kind: options.kind,
		});
		this.setActive(header.session_id);
		this.copyEvents(this.openStore(header.session_id), tail);
		source.truncateFrom(sequence);
		return header;
	}

	/** 复制事件行到目标库：保序保 id（caused_by 链不断）；thread_id 归零 ——
	 * 事件归属由"库"本身决定，不再靠标签过滤。 */
	private copyEvents(target: SqliteEventStore, events: EventBase[]): void {
		if (events.length === 0) return;
		target.appendBatch(
			events.map((event) => ({
				event_id: event.event_id,
				sequence: event.sequence,
				actor_id: event.actor_id,
				type: event.type,
				payload: event.payload,
				caused_by: event.caused_by,
				correlation_id: event.correlation_id,
				timestamp: event.timestamp,
				schema_version: event.schema_version,
				idempotency_key: undefined,
				thread_id: undefined,
			})),
		);
	}

	/** 把外部事件行导入指定会话库（跨工作区 fork 用）：保 id 保序。 */
	importEvents(sessionId: string, events: EventBase[]): void {
		this.copyEvents(this.openStore(sessionId), events);
	}

	/** 首条用户消息（snippet 兜底），从会话自己的库读。 */
	firstUserMessage(sessionId: string, limit = 200): string | undefined {
		try {
			const store = this.openStore(sessionId);
			for (const event of store.query({ types: ["USER_MESSAGE"], limit: 5 })) {
				const payload = event.payload as { content?: string | unknown[] };
				const text =
					typeof payload.content === "string"
						? payload.content
						: Array.isArray(payload.content)
							? payload.content
									.map((block) =>
										block && typeof block === "object" && "text" in block
											? String((block as { text: unknown }).text)
											: "",
									)
									.join(" ")
							: "";
				const trimmed = text.replace(/\s+/g, " ").trim();
				if (trimmed) return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
			}
		} catch {
			/* 库缺失按无消息处理 */
		}
		return undefined;
	}

	/** USER_MESSAGE 落库时补标题（仅首条；替代旧模型的侧栏现场探测）。 */
	noteUserMessage(payload: unknown): void {
		const id = this.activeSessionId;
		if (!id) return;
		const header = this.getHeader(id);
		if (!header || header.title) return;
		const content = (payload as { content?: string | unknown[] }).content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((block) =>
								block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "",
							)
							.join(" ")
					: "";
		const trimmed = text.replace(/\s+/g, " ").trim();
		if (!trimmed) return;
		header.title = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
		this.saveHeader(header);
	}

	rename(sessionId: string, title: string): void {
		const header = this.getHeader(sessionId);
		if (!header) return;
		header.title = title;
		this.saveHeader(header);
	}

	/** 活跃会话是否为空壳（无任何用户/助手内容）。 */
	isActiveEmpty(): boolean {
		const id = this.activeSessionId;
		if (!id) return true;
		try {
			return this.openStore(id).query({ types: ["USER_MESSAGE", "AGENT_MESSAGE_END"] }).length === 0;
		} catch {
			return true;
		}
	}

	// ── 谱系树 ──────────────────────────────────────────────────────────────

	/**
	 * 会话谱系树（扁平深度优先）。默认取活跃会话所在谱系；传 focusSessionId
	 * 取目标会话的谱系 —— GUI 查看历史对话时与对话页看同一棵树。
	 */
	buildLineageNodes(focusSessionId?: string): HistoryTreeNodeInfo[] {
		const all = this.listSessions();
		const byId = new Map(all.map((h) => [h.session_id, h]));
		const anchorId = focusSessionId ?? this.activeSessionId;
		const anchor = anchorId ? byId.get(anchorId) : undefined;

		// 谱系锚点 = 沿 parent 链走到顶的根。
		let rootId: string | undefined = anchor?.session_id;
		if (anchor) {
			const seen = new Set<string>();
			let cur: SessionFileHeader | undefined = anchor;
			while (cur?.parent_session_id && !seen.has(cur.parent_session_id)) {
				seen.add(cur.parent_session_id);
				const parent = byId.get(cur.parent_session_id);
				if (!parent) break;
				rootId = parent.session_id;
				cur = parent;
			}
		}

		// 同根成员：沿各自祖先链能到达 rootId。
		const reaches = (header: SessionFileHeader, targetId: string): boolean => {
			let cur: SessionFileHeader | undefined = header;
			const seen = new Set<string>();
			while (cur && !seen.has(cur.session_id)) {
				seen.add(cur.session_id);
				if (cur.session_id === targetId) return true;
				cur = cur.parent_session_id ? byId.get(cur.parent_session_id) : undefined;
			}
			return false;
		};
		const scoped = rootId ? all.filter((h) => reaches(h, rootId!)) : all;
		const scopedIds = new Set(scoped.map((h) => h.session_id));

		const children = new Map<string, SessionFileHeader[]>();
		const roots: SessionFileHeader[] = [];
		for (const header of scoped) {
			const parentId = header.parent_session_id;
			if (parentId && scopedIds.has(parentId)) {
				const list = children.get(parentId) ?? [];
				list.push(header);
				children.set(parentId, list);
			} else {
				roots.push(header);
			}
		}
		const byCreated = (a: SessionFileHeader, b: SessionFileHeader) => a.created_at - b.created_at;
		roots.sort(byCreated);
		for (const list of children.values()) list.sort(byCreated);

		const nodes: HistoryTreeNodeInfo[] = [];
		const snippetCache = new Map<string, string | undefined>();
		const snippetOf = (id: string): string | undefined => {
			if (!snippetCache.has(id)) snippetCache.set(id, this.firstUserMessage(id));
			return snippetCache.get(id);
		};
		const visit = (header: SessionFileHeader, depth: number): void => {
			const childList = children.get(header.session_id) ?? [];
			nodes.push({
				session_id: header.session_id,
				thread_id: header.session_id,
				name: header.title,
				created_at: header.created_at,
				created_by: header.created_by,
				parent_session_id: header.parent_session_id,
				depth,
				child_count: childList.length,
				is_active: header.session_id === this.activeSessionId,
				closed: false,
				snippet: snippetOf(header.session_id),
				fork_at_event_id: header.fork_at_event_id,
			});
			for (const child of childList) visit(child, depth + 1);
		};
		for (const root of roots) visit(root, 0);
		return nodes;
	}

	/** thread 概念的 shim：thread_id === sessionId。 */
	threadShim(sessionId: string): ThreadDescriptor {
		const header = this.getHeader(sessionId);
		return {
			thread_id: sessionId,
			workspace_id: this.workspace_id,
			name: header?.title,
			created_at: header?.created_at ?? Date.now(),
			status: sessionId === this.activeSessionId ? "active" : "closed",
		};
	}

	// ── 旧库迁移 ────────────────────────────────────────────────────────────

	/**
	 * 旧"一工作区一大库 + 区间索引"→ 每会话一库。幂等：marker 优先；sessions
	 * 下已有会话也跳过。对每个旧会话描述符物化其投影视面（raw 全类型），保
	 * id 保序写入新库；parent/forkAt/标题进 header；旧库文件原样保留。
	 */
	private ensureMigrated(agentDir: string, cwd?: string): void {
		if (this.memory) return;
		try {
			if (existsSync(join(this.root, MIGRATED_MARKER))) return;
			const hasSessions = readdirSync(this.root, { withFileTypes: true }).some((e) => e.isDirectory());
			if (!hasSessions) {
				const legacyDb = getEventDatabasePath(this.workspace_id, agentDir);
				if (existsSync(legacyDb)) {
					this.migrateLegacyStore(legacyDb, cwd);
				}
			}
			writeFileSync(join(this.root, MIGRATED_MARKER), new Date().toISOString());
		} catch (error) {
			// 迁移失败不阻断启动：旧库数据仍在；不写 marker，下次启动重试。
			console.error("[session-files] legacy migration failed:", error);
		}
	}

	private migrateLegacyStore(legacyDbPath: string, cwd?: string): void {
		const legacy = new SqliteEventStore(this.workspace_id, legacyDbPath, "session_migration");
		try {
			const index = legacy.getSessionIndex();
			if (!index || index.sessions.length === 0) return;
			for (const descriptor of index.sessions) {
				if (this.getHeader(descriptor.session_id)) continue;
				const projection = new SessionProjection(legacy, descriptor);
				const events = projection.getSessionEvents();
				const header = this.createSessionInternal(descriptor.session_id, {
					name: descriptor.name,
					created_by: descriptor.created_by,
					parentSessionId: descriptor.parent_session_id,
					summaryEventId: descriptor.summary_event_id,
					kind: descriptor.name?.startsWith("scheduled: ") ? "scheduled" : undefined,
					cwd,
				});
				this.copyEvents(this.openStore(header.session_id), events);
			}
			if (index.active_session_id && this.getHeader(index.active_session_id)) {
				this.setActive(index.active_session_id);
			}
		} finally {
			legacy.close();
		}
	}

	dispose(): void {
		for (const store of this.storeCache.values()) {
			try {
				store.close();
			} catch {
				/* 尽力关闭 */
			}
		}
		this.storeCache.clear();
	}
}

/** 跨工作区读取入口：确保目标工作区已迁移，返回其会话管理器（读 header / 开库）。 */
export function openWorkspaceSessionManager(workspaceId: string, agentDir?: string): SessionFileStoreManager {
	return new SessionFileStoreManager(workspaceId, agentDir);
}
