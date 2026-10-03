/**
 * RPC protocol types — shared between the agent (src/) and consumers (apps/web/).
 *
 * This package is dependency-free. Types that reference agent internals
 * (AgentMessage, CompactionResult, BashResult, SessionStats, SourceInfo)
 * are declared as `unknown` here so consumers don't need to install the
 * full agent core. The agent side re-exports a typed version from
 * src/modes/rpc/rpc-types.ts with proper type parameters filled in.
 */

// ============================================================================
// Primitives (dependency-free)
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Minimal model info — enough for UI rendering without pulling in
 * @earendil-works/pi-ai's Model<any> type.
 */
export interface ModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	/** Whether the user has configured auth (API key / OAuth) for this model. */
	hasAuth?: boolean;
	/** Whether the provider was explicitly added by the user via models.json. */
	custom?: boolean;
}

// ============================================================================
// Scheduled tasks (ported from the zharness fusion scheduler)
// ============================================================================

export type ScheduleMode =
	| "every_n_minutes"
	| "every_n_hours"
	| "daily"
	| "weekdays"
	| "weekly"
	| "monthly"
	| "cron"
	/** 单次:到 startAt 触发一次后自动停用(设计稿「单次」,无生效日期区间)。 */
	| "once";

/** 24h wall-clock time. */
export interface TimeOfDay {
	hour: number; // 0-23
	minute: number; // 0-59
}

/** 0 = Sunday, 1 = Monday, ..., 6 = Saturday (matches JS Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Day-of-month, 1-31. */
export type DayOfMonth = number;

/**
 * ScheduleSpec is the canonical, fully-unrolled schedule for one task.
 * Each field is optional except where the chosen mode requires it.
 */
export interface ScheduleSpec {
	mode: ScheduleMode;
	/** every_n_minutes / every_n_hours */
	everyN?: { n: number; unit: "minute" | "hour" };
	/** daily / weekdays / weekly / monthly. Always an array (possibly empty). */
	times?: TimeOfDay[];
	/** weekly (multi-select). */
	weekdays?: Weekday[];
	/** monthly (multi-select). */
	daysOfMonth?: DayOfMonth[];
	/** cron mode. */
	cron?: { expression: string; tz?: string };
	/** First allowed fire time (epoch ms). Defaults to creation time. */
	startAt?: number;
	/** Last allowed fire time (epoch ms). Omit = forever. */
	endAt?: number;
}

/**
 * A persisted scheduled task. One task = one schedule + one prompt message
 * that gets dispatched to the agent at every fire time.
 */
export interface ScheduledTask {
	id: string;
	/** Display name. Defaults to first 30 chars of prompt. */
	name: string;
	/** Message to dispatch to the agent at every fire time. */
	prompt: string;
	/**
	 * Which scope owns this task.
	 *   - "main"       → stored at ~/.zharness/main/scheduler/tasks.json
	 *   - "workspace"  → stored at ~/.zharness/agent/workspaces/<workspaceId>/scheduler/tasks.json
	 * When scope === "workspace", workspaceId must be set.
	 */
	scope: "main" | "workspace";
	/** Workspace id when scope === "workspace". */
	workspaceId?: string;
	schedule: ScheduleSpec;
	enabled: boolean;
	/** 任务内容/备注(设计稿「任务内容」选填)。 */
	description?: string;
	/** Last successful fire time (epoch ms). */
	lastRunAt?: number;
	/** Status of the most recent run. */
	lastRunStatus?: "ok" | "failed" | "skipped";
	/** Event id of the last USER_MESSAGE event produced by this task. */
	lastRunEventId?: string;
	/** Number of times this task has fired since creation. */
	runCount?: number;
	createdAt: number;
	updatedAt: number;
	/** "user" = manual creation, "intent" = natural-language chat intent. */
	createdBy: "user" | "intent";
	/** Original user sentence when createdBy === "intent" (auditability). */
	sourceText?: string;
	/**
	 * Which session the task runs in at each fire time.
	 *   - { kind: "pinned", sessionId } → dispatch into the saved logical session
	 *   - { kind: "new", purpose }      → each fire creates a fresh session whose
	 *                                     first user message is the task prompt
	 */
	sessionTarget?: SessionTarget;
	/**
	 * What to do when this task wants to fire but its target session is
	 * already running another task. Default: "skip" (cron-style drop the tick).
	 */
	concurrencyPolicy?: ConcurrencyPolicy;
	/**
	 * Auto-release the session lock and mark the task as failed if it
	 * doesn't finish within this many minutes. 0 = no timeout (default).
	 */
	timeoutMinutes?: number;
	/**
	 * Safety cap: auto-disable the task once runCount reaches this value.
	 * 0/undefined = unlimited.
	 */
	maxRuns?: number;
	/**
	 * 跨进程「立即运行」请求标记(epoch ms):任务不属于当前 sidecar 服务的
	 * scope 时,GUI 所在 sidecar 无法本地触发,改为在任务上写此标记落盘;
	 * 拥有该 scope 的活跃引擎经 tasks.json 监听发现后手动触发一次并清除。
	 */
	runRequestedAt?: number;
}

/**
 * Where a task runs when it fires.
 */
export type SessionTarget =
	| { kind: "pinned"; sessionId?: string; label?: string }
	/** @deprecated kept only so old tasks can be migrated through the UI. */
	| { kind: "current" }
	| { kind: "new"; purpose: string };

/**
 * What to do when a second task wants to run while another is in flight
 * in the same target session.
 */
export type ConcurrencyPolicy = "skip" | "queue" | "preempt";

/**
 * Per-scope scheduler policy (the global defaults for newly-created
 * tasks). Persisted in settings.json. Per-task fields on ScheduledTask
 * override these defaults.
 */
export interface SchedulerPolicy {
	concurrency: ConcurrencyPolicy;
	timeoutMinutes: number;
	defaultSessionTarget: SessionTarget;
}

/** Lightweight status snapshot returned to UI when listing tasks. */
export interface ScheduledTaskSummary extends ScheduledTask {
	/** Next scheduled fire time, or null if disabled / past endAt. */
	nextRunAt: number | null;
	/** 任务所属工作区的 cwd(workspace scope 时给前端做项目名映射)。 */
	workspaceCwd?: string;
}

/** One record in runs.jsonl — appended on every fire. */
export interface ScheduledTaskRun {
	taskId: string;
	at: number;
	status: "ok" | "failed" | "skipped";
	/** Event id of the produced USER_MESSAGE (if any). */
	eventId?: string;
	/** Session id that received the scheduled prompt (if known). */
	sessionId?: string;
	/** Optional error / skip reason. */
	reason?: string;
}

/** Default limit for schedule_history RPC. */
export const SCHEDULE_HISTORY_DEFAULT_LIMIT = 50;

/** Maximum time points a user can attach to one schedule. */
export const SCHEDULE_MAX_TIME_POINTS = 32;

/** Maximum days/weekdays in one schedule. */
export const SCHEDULE_MAX_DAYS = 31;

export interface ScheduledTaskCreateInput {
	name: string;
	prompt: string;
	scope: "main" | "workspace";
	workspaceId?: string;
	schedule: ScheduleSpec;
	enabled?: boolean;
	description?: string;
	createdBy?: "user" | "intent";
	sourceText?: string;
	startAt?: number;
	endAt?: number;
	sessionTarget?: SessionTarget;
	concurrencyPolicy?: ConcurrencyPolicy;
	timeoutMinutes?: number;
}

/** Patch object for schedule_update. Any field omitted is left unchanged. */
export interface ScheduledTaskPatch {
	name?: string;
	prompt?: string;
	schedule?: ScheduleSpec;
	enabled?: boolean;
	description?: string | null;
	startAt?: number | null;
	endAt?: number | null;
	sessionTarget?: SessionTarget | null;
	concurrencyPolicy?: ConcurrencyPolicy | null;
	timeoutMinutes?: number | null;
}

// ============================================================================
// Codegen pipeline (codegen-sma built-in extension, RightDock panel)
// ============================================================================

/** One stage record from .codegen/state.json (append-only audit trail). */
export interface RpcCodegenStageRecord {
	stage: string;
	attempt: number;
	/** passed=门禁通过; failed=门禁/episode 失败; blocked=episode 报告阻塞; user-rejected=用户驳回 */
	status: "passed" | "failed" | "blocked" | "user-rejected";
	summary?: string;
	evidence?: string;
	changedFiles?: string[];
}

/** Pipeline state as returned by the `codegen` RPC. */
export interface RpcCodegenState {
	goal: string;
	stageIndex: number;
	attempt: number;
	stageOrder: string[];
	records: RpcCodegenStageRecord[];
	startedAt: string;
	finishedAt?: string;
	/** aborted = 用户主动中止(断点保留,可 resume) */
	outcome?: "completed" | "blocked" | "abandoned" | "aborted";
}

// ============================================================================
// Lightweight session summary (sidebar)
// ============================================================================

/** Index-only session summary for the sidebar (sessions mapped per workspace). */
export interface RpcWorkspaceSessionSummary {
	workspace_id: string;
	cwd: string;
	session_id: string;
	/** All session ids aggregated into this conversation row (same first user message). */
	session_ids?: string[];
	name?: string;
	title: string;
	created_at: number;
	parent_session_id?: string;
}

// ============================================================================
// Context editor (context-editor built-in extension, Composer dialog)
// ============================================================================

/** 覆盖生效范围：once = 仅下一次；persistent = 本会话后续每次。 */
export type RpcOverrideScope = "once" | "persistent";

/** 一条上下文消息的预览视图（context_preview 返回）。 */
export interface RpcContextMessage {
	/** 源事件 id（编辑以此定位）。 */
	eventId?: string;
	/** 角色分类（UI 着色依据）：user/assistant/toolResult/… */
	kind:
		| "user"
		| "assistant"
		| "toolResult"
		| "compactionSummary"
		| "branchSummary"
		| "custom"
		| "bashExecution"
		| string;
	role: string;
	/** 展示/编辑用全文。 */
	text: string;
	/** 是否真正进入下一次 LLM 请求（镜像发送层的角色过滤）。 */
	sentToLlm: boolean;
	editable: boolean;
	deletable: boolean;
	/** 不可编辑/不可删除/不发送的原因。 */
	note?: string;
	meta?: {
		toolName?: string;
		toolCallNames?: string[];
		isError?: boolean;
		hasImages?: boolean;
		customType?: string;
		tokensBefore?: number;
	};
	charCount: number;
	timestamp?: number;
	/** 当前已施加的编辑（预演下一次请求的实际内容）。 */
	appliedEdit?: {
		action: "edit" | "delete";
		scope: RpcOverrideScope;
	};
}

/** 一个工具定义的预览视图。 */
export interface RpcContextTool {
	name: string;
	description: string;
	/** 参数 JSON schema（序列化文本）。 */
	parametersJson: string;
}

/** context_preview / context_apply / context_overrides_clear 返回的覆盖状态快照。 */
export interface RpcContextOverridesSnapshot {
	extensionLoaded: boolean;
	systemPromptOverride?: { text: string; scope: RpcOverrideScope };
	/** once 消费后待还原的原系统提示词（预演时会体现）。 */
	restoreBaseSystemPrompt?: string;
	/** 首次 persistent 覆盖前的原系统提示词（清除时恢复用）。 */
	baseBeforePersistent?: string;
	messageEdits: Record<string, { action: "edit" | "delete"; text?: string; scope: RpcOverrideScope }>;
}

/** context_preview 响应数据。 */
export interface RpcContextPreviewData {
	/** 下一次发送实际生效的系统提示词（覆盖预演后的结果）。 */
	effectiveSystemPrompt: string;
	/** runtime 当前持有的系统提示词（未做覆盖预演）。 */
	currentSystemPrompt: string;
	/** 系统提示词是否被覆盖改写。 */
	systemPromptOverridden: boolean;
	systemPromptOverrideScope?: RpcOverrideScope;
	tools: RpcContextTool[];
	messages: RpcContextMessage[];
	/** 待发送的用户消息（调用方传入 pendingUserMessage 时的展示位）。 */
	pendingUserMessage?: string;
	/** 扩展是否已加载（禁用时编辑不会生效，仅可查看）。 */
	extensionLoaded: boolean;
	overrides: RpcContextOverridesSnapshot;
	sessionId: string;
	/** 上下文窗口预算（token，粗略）。 */
	contextBudget?: number;
}

/** 打分维度（context_score 返回）。 */
export interface RpcContextScoreDimension {
	/** 维度键：relevance / redundancy / coherence / efficiency / reliability。 */
	key: string;
	/** 0-100，越高越好。 */
	score: number;
	/** 一句话点评。 */
	comment?: string;
}

/** 逐条消息标注（context_score 返回）。 */
export interface RpcContextScoreAnnotation {
	/** 源事件 id（context_preview 返回的消息定位）。 */
	eventId?: string;
	/** 消息序号（对齐 context_preview 的 messages 下标）。 */
	index: number;
	/** 该消息对下一轮的价值。 */
	label: "high" | "medium" | "low";
	/** 判定理由。 */
	reason?: string;
	/** 处置建议。 */
	suggestion?: "keep" | "trim" | "edit" | "delete";
}

/** 打分结果（context_score 返回）。 */
export interface RpcContextScoreResult {
	overall: number;
	dimensions: RpcContextScoreDimension[];
	/** 总评一句话。 */
	summary: string;
	messageAnnotations: RpcContextScoreAnnotation[];
	generatedAt: number;
}

/** 打分任务状态（start 立即返回，前端轮询 status）。 */
export interface RpcContextScoreStatus {
	status: "idle" | "running" | "done" | "error";
	/** 打分时的上下文指纹（调用方比对当前指纹判断是否过期）。 */
	fingerprint?: string;
	/** 缓存结果是否已过期。 */
	stale?: boolean;
	startedAt?: number;
	finishedAt?: number;
	/** 打分所用模型。 */
	model?: string;
	error?: string;
	result?: RpcContextScoreResult;
}

// ============================================================================
// Proactive assistant (proactive-assistant built-in extension, floating widget)
// ============================================================================

/** 建议类别（镜像 agent 侧 SuggestionKind）。 */
export type RpcAssistantSuggestionKind = "stuck_hint" | "knowledge_offer" | "context_hint";

/** 建议上可执行的动作（镜像 agent 侧 SuggestionAction）。 */
export type RpcAssistantAction =
	| { kind: "compact" }
	| { kind: "steer"; text: string }
	| { kind: "continue" }
	| { kind: "save_knowledge" }
	| { kind: "dismiss" };

/** 一条主动建议，as returned by `proactive_assistant list`. */
export interface RpcAssistantSuggestion {
	id: string;
	kind: RpcAssistantSuggestionKind;
	severity: "info" | "warning";
	title: string;
	body: string;
	actions: RpcAssistantAction[];
	createdAt: number;
	sessionId: string;
	/** 规则 id（S1..S5/K1），诊断用。 */
	ruleId: string;
}

/** proactive_assistant list 返回的状态快照。 */
export interface RpcAssistantStateData {
	extensionLoaded: boolean;
	suggestions: RpcAssistantSuggestion[];
	/** 免打扰截止（epoch ms，0 = 未静默）。 */
	mutedUntil: number;
	/** 会话内用户轮数。 */
	userTurns: number;
	/** 本会话是否已提示过知识沉淀。 */
	knowledgeOffered: boolean;
}

/** knowledge_draft 返回的草稿。 */
export interface RpcAssistantKnowledgeDraft {
	title: string;
	content: string;
	tags: string[];
	/** 草稿对应的建议 id（保存后该建议自动消失）。 */
	suggestionId?: string;
}

/** knowledge_save 返回的落盘结果。 */
export interface RpcAssistantKnowledgeSaveResult {
	path: string;
	indexUpdated: boolean;
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: unknown[] }
	| { id?: string; type: "follow_up"; message: string; images?: unknown[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "rewind"; targetEventId?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }

	// Messages
	/** 无 sessionId:当前活跃会话;带 sessionId:该会话的有界区间查看(只读,不切换活跃位)。 */
	| { id?: string; type: "get_messages"; sessionId?: string }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// History tree / event forensics (web docks)
	/** `sessionId` = 联动锚点:按目标所属对话(线程)取树;缺省取活跃对话。 */
	| { id?: string; type: "history_tree"; action: "list"; query?: string; sessionId?: string }
	| { id?: string; type: "history_tree"; action: "view"; sessionId: string; maxMessages?: number }
	| { id?: string; type: "history_tree"; action: "jump"; sessionId: string; reason?: string }
	| { id?: string; type: "history_tree"; action: "fork"; sessionId: string }
	| { id?: string; type: "history_tree"; action: "rename"; sessionId: string; name: string }
	| { id?: string; type: "get_events"; eventTypes?: string[]; limit?: number; sessionScoped?: boolean; sessionId?: string }

	// Sessions of every workspace (sidebar mapping; index-only lightweight scan)
	| { id?: string; type: "list_sessions" }

	// Codegen pipeline (codegen-sma built-in extension; RightDock panel)
	| { id?: string; type: "codegen"; action: "status" }
	| { id?: string; type: "codegen"; action: "start"; goal: string }
	| { id?: string; type: "codegen"; action: "resume" }
	| { id?: string; type: "codegen"; action: "abort" }

	// Scheduled tasks (scheduler engine; main + workspace scopes)
	| { id?: string; type: "get_scheduler_policy" }
	| { id?: string; type: "set_scheduler_policy"; policy: SchedulerPolicy }
	| { id?: string; type: "schedule_list"; scope?: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_create"; task: ScheduledTaskCreateInput }
	| { id?: string; type: "schedule_update"; taskId: string; patch: ScheduledTaskPatch; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_delete"; taskId: string; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_run_now"; taskId: string; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_reload"; scope?: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_history"; taskId: string; scope: "main" | "workspace"; workspaceId?: string; limit?: number }

	// Task replay (read-only; replay-summary.json + artifacts under <ws>/replay/<sessionId>/)
	| { id?: string; type: "get_replay_summary"; sessionId?: string }
	| { id?: string; type: "list_replay_sessions" }
	| { id?: string; type: "list_replay_dir"; sessionId?: string; path?: string }
	| { id?: string; type: "read_replay_file"; sessionId?: string; path: string }

	// Task board (task-board built-in extension; per-workspace kanban)
	// workspaceId 可选:GUI 首页看板固定读写主对话工作区,不随当前会话工作区切换;
	// 缺省时跟随 sidecar 当前工作区(agent 工具 / 斜杠命令语义不变)。
	| { id?: string; type: "task_board"; action: "list"; workspaceId?: string }
	| {
			id?: string;
			type: "task_board";
			action: "create";
			workspaceId?: string;
			title: string;
			project?: string;
			priority?: RpcTaskPriority;
			status?: RpcTaskStatus;
			zentaoId?: string;
			dueAt?: string;
	  }
	| {
			id?: string;
			type: "task_board";
			action: "update";
			workspaceId?: string;
			taskId: string;
			title?: string;
			project?: string;
			priority?: RpcTaskPriority;
			status?: RpcTaskStatus;
			zentaoId?: string;
			dueAt?: string;
	  }
	| { id?: string; type: "task_board"; action: "delete"; workspaceId?: string; taskId: string }

	// Approval (safe mode)
	| { id?: string; type: "approve"; intentEventId: string }
	| { id?: string; type: "reject"; intentEventId: string }
	| { id?: string; type: "set_safe_mode"; enabled: boolean }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "get_skills" }
	| { id?: string; type: "get_extensions" }
	| { id?: string; type: "set_extension_enabled"; extensionId: string; enabled: boolean }
	| { id?: string; type: "install_extension"; extensionId: string }
	| { id?: string; type: "uninstall_extension"; extensionId: string }
	// Skill directory (skills.sh): install a GitHub-hosted skill into <agentDir>/skills/<slug>.
	// `source` is the skills.sh leaderboard source ("owner/repo"); `slug` is the skill name.
	| { id?: string; type: "install_skill"; source: string; slug: string }
	// SOP market: installed workflows live in <agentDir>/sops/<slug>/SOP.md.
	// `sop_list` returns them; `sop_market` returns the distributable directory
	// (bundled templates first, `installed` flag per entry).
	| { id?: string; type: "sop_list" }
	| { id?: string; type: "sop_market" }
	// Install a SOP: `source` is "builtin" for bundled templates or a GitHub
	// "owner/repo" for market templates (shallow clone, same as install_skill).
	| { id?: string; type: "sop_install"; source: string; slug: string }
	| { id?: string; type: "sop_uninstall"; slug: string }
	// Provider auth: reload in-memory credentials from auth.json (used after the
	// desktop bridge edits auth.json out-of-band, so a model switch picks up the
	// new key instead of the stale in-memory cache or an env-var fallback).
	| { id?: string; type: "reload_providers" }
	// Persona: main-agent identity (SOUL.md) + user long-term memory
	// (user-profile.md) for the personified GUI. Read-only.
	| { id?: string; type: "get_persona" }
	// Context editor (context-editor built-in extension; Composer dialog)
	| { id?: string; type: "context_preview"; pendingUserMessage?: string }
	| {
			id?: string;
			type: "context_apply";
			/** null = 清除系统提示词覆盖。 */
			systemPrompt?: { text: string; scope: RpcOverrideScope } | null;
			/**
			 * 逐条消息编辑；eventId 为 context_preview 返回的源事件 id。空数组 = 不变。
			 * action: edit = 改文本（需 text）；delete = 从下次请求中移除；
			 * clear = 撤销该消息上已存在的编辑。
			 */
			messageEdits?: Array<{
				eventId: string;
				action: "edit" | "delete" | "clear";
				text?: string;
				scope: RpcOverrideScope;
			}>;
	  }
	| { id?: string; type: "context_overrides_clear"; target?: "all" | "systemPrompt" | "messageEdits" }
	// Context scoring (context-editor built-in extension): start 立即返回 running,
	// 前端轮询 status；结果按上下文指纹缓存，force 可强制重打。
	| {
			id?: string;
			type: "context_score";
			action: "start" | "status" | "cancel";
			/** 与 start 相同的待发送草稿（参与指纹，轮询时带上）。 */
			pendingUserMessage?: string;
			/** 忽略指纹缓存强制重新打分。 */
			force?: boolean;
	  }

	// Proactive assistant (proactive-assistant built-in extension; floating widget)
	| { id?: string; type: "proactive_assistant"; action: "list" }
	| { id?: string; type: "proactive_assistant"; action: "dismiss"; suggestionId: string }
	| { id?: string; type: "proactive_assistant"; action: "apply"; suggestionId: string }
	| { id?: string; type: "proactive_assistant"; action: "knowledge_draft"; suggestionId: string }
	| { id?: string; type: "proactive_assistant"; action: "knowledge_save"; title: string; content: string; tags?: string[] }
	| { id?: string; type: "proactive_assistant"; action: "clear" }
	| { id?: string; type: "proactive_assistant"; action: "mute"; minutes: number }

	// Skins (skins built-in extension; SettingsView skin library)
	| { id?: string; type: "skin_state" }
	| {
			id?: string;
			type: "skin_apply";
			skinId: string;
			/** 自定义图片皮肤可顺带调节遮罩/模糊。 */
			dim?: number;
			blur?: number;
	  }
	| { id?: string; type: "skin_add"; name: string; dataUrl: string; dim?: number; blur?: number }
	| { id?: string; type: "skin_remove"; skinId: string }
	| { id?: string; type: "skin_image"; skinId: string }
	| { id?: string; type: "skin_rename"; skinId: string; name: string }

	// Pets (pets built-in extension; floating pet widget)
	| { id?: string; type: "pet_state" }
	| { id?: string; type: "pet_hatch" }
	| { id?: string; type: "pet_interact"; action: "feed" | "play"; petId: string }
	| { id?: string; type: "pet_rename"; petId: string; name: string }
	| { id?: string; type: "pet_carry"; petId: string }
	| { id?: string; type: "pet_release"; petId: string };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: unknown;
}

// ============================================================================
// Task Board payloads (task-board built-in extension)
// ============================================================================

export type RpcTaskStatus = "not_started" | "in_progress" | "completed";
export type RpcTaskPriority = "high" | "medium" | "low";

/** One task card, as returned by `task_board`. Mirrors apps/web TaskItem. */
export interface RpcTaskItem {
	id: string;
	title: string;
	status: RpcTaskStatus;
	priority: RpcTaskPriority;
	/** 所属项目标签，如 "D6.0" / "国际化"。 */
	project: string;
	/** 关联的禅道需求/任务 ID（可选）。 */
	zentaoId?: string;
	/** ISO 日期（YYYY-MM-DD）。 */
	createdAt: string;
	dueAt: string;
}

/** Discriminated result of the `task_board` command by action. */
export type RpcTaskBoardResult =
	| { action: "list"; tasks: RpcTaskItem[] }
	| { action: "create"; task: RpcTaskItem }
	| { action: "update"; task: RpcTaskItem | null }
	| { action: "delete"; deleted: boolean };

// ============================================================================
// Skins payloads (skins built-in extension)
// ============================================================================

/** One skin, builtin palette or custom image. */
export interface RpcSkin {
	id: string;
	name: string;
	kind: "builtin" | "custom";
	description?: string;
	/** 色板覆盖（内置色板皮肤）：CSS 变量名 → 值，按 light/dark 分套。 */
	colors?: {
		light: Record<string, string>;
		dark: Record<string, string>;
	};
	/** 自定义图片皮肤元数据（图片本体经 skin_image 拉 data URL）。 */
	image?: {
		mime: string;
		dim: number;
		blur: number;
	};
}

/** Result of `skin_state`. */
export interface RpcSkinState {
	skins: RpcSkin[];
	activeSkinId: string;
}

/** Result of `skin_image`: the image as a data URL, or null when the skin has none. */
export type RpcSkinImage = { dataUrl: string | null };

// ============================================================================
// Pets payloads (pets built-in extension)
// ============================================================================

export type RpcPetRarity = "N" | "R" | "SR" | "SSR";

/** One pet record. */
export interface RpcPet {
	id: string;
	name: string;
	/** 种族 id（图鉴）。 */
	speciesId: string;
	/** 个性 id。 */
	personalityId: string;
	rarity: RpcPetRarity;
	shiny: boolean;
	mood: number;
	energy: number;
	bond: number;
	/** ISO 时间。 */
	hatchedAt: string;
	lastFedAt?: string;
	lastPlayedAt?: string;
}

/** 宠物 + 图鉴合成视图（GUI 直接渲染用）。 */
export interface RpcPetView {
	pet: RpcPet;
	speciesName: string;
	speciesEmoji: string;
	speciesColor: string;
	blurb: string;
	personalityName: string;
	catchphrase: string;
}

/** 盲盒抽取原始结果（开箱动画展示）。 */
export interface RpcBlindBoxDraw {
	speciesId: string;
	speciesName: string;
	rarity: RpcPetRarity;
	shiny: boolean;
}

/** Result of `pet_hatch`. */
export interface RpcHatchResult {
	pet: RpcPet | null;
	draw: RpcBlindBoxDraw;
	/** 档案已满（上限 30 只），本次未入册。 */
	overflow: boolean;
}

/** Result of `pet_interact`. */
export interface RpcPetInteractResult {
	kind: "feed" | "play";
	pet: RpcPet | null;
	moodDelta: number;
	energyDelta: number;
	/** false = 今日已互动过或宠物不存在。 */
	effected: boolean;
}

/** Result of `pet_state`. */
export interface RpcPetsState {
	pets: RpcPet[];
	activePetId?: string;
	/** 携带中的宠物视图（无档案为 null）。 */
	activePetView: RpcPetView | null;
	totalHatched: number;
}

/** A user-invocable skill (from ~/.zharness skills), as returned by get_skills. */
export interface RpcSkillInfo {
	/** Command name without leading slash (e.g. "skill:my-skill"). */
	command: string;
	/** Human-readable name. */
	name: string;
	description?: string;
}

/** An installed SOP workflow template, as returned by sop_list. */
export interface RpcSopInfo {
	slug: string;
	name: string;
	description?: string;
	version?: string;
	author?: string;
	tags: string[];
	/** "static" = declarative steps; "dynamic" = workflow.ts script orchestrating subagents. */
	kind: "static" | "dynamic";
	/** Declared run arguments (name + required flag). */
	args: Array<{ name: string; required: boolean }>;
	/** Number of workflow steps (static only; 0 for dynamic). */
	stepCount: number;
	/** Installed SOP.md path. */
	path: string;
}

/** A market directory entry, as returned by sop_market. */
export interface RpcSopMarketEntry {
	slug: string;
	name: string;
	description?: string;
	version?: string;
	author?: string;
	tags: string[];
	/** "static" = declarative steps; "dynamic" = workflow.ts script orchestrating subagents. */
	kind: "static" | "dynamic";
	stepCount: number;
	/** Where the template comes from: "builtin" or "github:<owner/repo>". */
	source: string;
	/** True when the slug is already installed locally. */
	installed: boolean;
}

/** An extension loaded by the agent, as returned by get_extensions. */
export interface RpcExtensionInfo {
	/** Stable id. For built-in extensions this is the built-in id (e.g. "agent-browser"); otherwise derived from the path. */
	id: string;
	/** Human-readable name. */
	name: string;
	description?: string;
	/** Where the extension comes from. */
	kind: "builtin" | "user" | "project" | "cli" | "package";
	/** Whether the extension is currently active (loaded). Disabled built-ins report false. */
	enabled: boolean;
	/** Whether toggling enable/disable is supported (currently only built-in extensions). */
	canToggle: boolean;
	/** Whether this extension ships an external dependency (e.g. a CLI binary) that can be installed/uninstalled. */
	installable: boolean;
	/** Whether the external dependency is currently installed. Only meaningful when installable is true. */
	installed: boolean;
	/** Internal path / source tag (e.g. "<builtin:agent-browser>" or a file path). */
	path: string;
	/** Number of tools this extension registers. */
	toolCount: number;
	/** Number of slash commands this extension registers. */
	commandCount: number;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	/** Local WebSocket PTY server port for the Terminal pane (0/undefined = unavailable). */
	ptyPort?: number;
	/** When true, risky tool calls require explicit user approval before running. */
	safeMode?: boolean;
	/** Estimated context window usage for the current session. */
	contextUsage?: RpcContextUsage;
	/** Cumulative token usage across all assistant messages in the session. */
	tokenUsage?: RpcTokenUsage;
}

export interface RpcContextUsage {
	/** Estimated context tokens, or null if unknown. */
	tokens: number | null;
	/** Model context window size in tokens. */
	contextWindow: number;
	/** Context usage as percentage of context window (0-100), or null if unknown. */
	percent: number | null;
}

export interface RpcTokenUsage {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "rewind"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| { id?: string; type: "response"; command: "set_model"; success: true; data: ModelInfo }
	| { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: ModelInfo[] } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: unknown[]; sessionId?: string } }

	// Commands
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }

	// History tree / event forensics
	| { id?: string; type: "response"; command: "history_tree"; success: true; data: RpcHistoryTreeResult }
	| { id?: string; type: "response"; command: "get_events"; success: true; data: { events: RpcForensicEvent[] } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: RpcWorkspaceSessionSummary[] } }
	// Codegen pipeline
	| { id?: string; type: "response"; command: "codegen"; success: true; data: { state: RpcCodegenState | null; running: boolean } }
	// Scheduled tasks
	| { id?: string; type: "response"; command: "get_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "set_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "schedule_list"; success: true; data: { tasks: ScheduledTaskSummary[] } }
	| { id?: string; type: "response"; command: "schedule_create"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_update"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_delete"; success: true; data: { ok: true; taskId: string } }
	| { id?: string; type: "response"; command: "schedule_run_now"; success: true; data: { fired: boolean; taskId: string; at: number } }
	| { id?: string; type: "response"; command: "schedule_reload"; success: true; data: { reloaded: number } }
	| { id?: string; type: "response"; command: "schedule_history"; success: true; data: { runs: ScheduledTaskRun[] } }
	// Task board
	| { id?: string; type: "response"; command: "task_board"; success: true; data: RpcTaskBoardResult }
	// Skins
	| { id?: string; type: "response"; command: "skin_state"; success: true; data: RpcSkinState }
	| { id?: string; type: "response"; command: "skin_apply"; success: true; data: { skin: RpcSkin | null } }
	| { id?: string; type: "response"; command: "skin_add"; success: true; data: { skin: RpcSkin } }
	| { id?: string; type: "response"; command: "skin_remove"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "skin_image"; success: true; data: RpcSkinImage }
	| { id?: string; type: "response"; command: "skin_rename"; success: true; data: { skin: RpcSkin | null } }
	// Pets
	| { id?: string; type: "response"; command: "pet_state"; success: true; data: RpcPetsState }
	| { id?: string; type: "response"; command: "pet_hatch"; success: true; data: RpcHatchResult }
	| { id?: string; type: "response"; command: "pet_interact"; success: true; data: RpcPetInteractResult }
	| { id?: string; type: "response"; command: "pet_rename"; success: true; data: { pet: RpcPet | null } }
	| { id?: string; type: "response"; command: "pet_carry"; success: true; data: { pet: RpcPet | null } }
	| { id?: string; type: "response"; command: "pet_release"; success: true; data: { released: boolean } }
	// Approval (safe mode)
	| { id?: string; type: "response"; command: "approve"; success: true }
	| { id?: string; type: "response"; command: "reject"; success: true }
	| { id?: string; type: "response"; command: "set_safe_mode"; success: true; data: { safeMode: boolean } }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { sessionId: string } }
	| { id?: string; type: "response"; command: "get_skills"; success: true; data: { skills: RpcSkillInfo[] } }
	| { id?: string; type: "response"; command: "get_extensions"; success: true; data: { extensions: RpcExtensionInfo[] } }
	| { id?: string; type: "response"; command: "set_extension_enabled"; success: true; data: { id: string; enabled: boolean; requiresReload: boolean } }
	| { id?: string; type: "response"; command: "install_extension"; success: true; data: { extensionId: string; ok: boolean; message: string; installed: boolean } }
	| { id?: string; type: "response"; command: "uninstall_extension"; success: true; data: { extensionId: string; ok: boolean; message: string; installed: boolean } }
	| { id?: string; type: "response"; command: "install_skill"; success: true; data: { slug: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "sop_list"; success: true; data: { sops: RpcSopInfo[] } }
	| { id?: string; type: "response"; command: "sop_market"; success: true; data: { entries: RpcSopMarketEntry[] } }
	| { id?: string; type: "response"; command: "sop_install"; success: true; data: { slug: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "sop_uninstall"; success: true; data: { slug: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "reload_providers"; success: true; data: { providers: string[] } }
	| { id?: string; type: "response"; command: "get_persona"; success: true; data: RpcPersonaData }
	// Context editor
	| { id?: string; type: "response"; command: "context_preview"; success: true; data: RpcContextPreviewData }
	| { id?: string; type: "response"; command: "context_apply"; success: true; data: RpcContextOverridesSnapshot }
	| { id?: string; type: "response"; command: "context_overrides_clear"; success: true; data: RpcContextOverridesSnapshot }
	| { id?: string; type: "response"; command: "context_score"; success: true; data: RpcContextScoreStatus }
	// Proactive assistant
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: RpcAssistantStateData }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: { dismissed: boolean } }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: { applied: boolean; action: RpcAssistantAction["kind"] } }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: RpcAssistantKnowledgeDraft }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: RpcAssistantKnowledgeSaveResult }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: { cleared: true } }
	| { id?: string; type: "response"; command: "proactive_assistant"; success: true; data: { mutedUntil: number } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Persona payload (personified GUI)
// ============================================================================

/** Main-agent identity (SOUL.md) as returned by `get_persona`. */
export interface RpcSoulFile {
	/** Absolute path of the soul file, so the GUI can offer "edit in editor". */
	path: string;
	/** Raw markdown content; null when the file does not exist. */
	content: string | null;
	/** True while the file is still the untouched placeholder template. */
	uninitialized: boolean;
}

/** User long-term memory entry (one .md file in the memory directory). */
export interface RpcMemoryEntry {
	/** Absolute path of the memory file. */
	path: string;
	/** Raw markdown content. */
	content: string;
}

/** Persona data returned by `get_persona`. */
export interface RpcPersonaData {
	/** Agent identity (SOUL.md). */
	soul: RpcSoulFile;
	/** Stable facts about the user (user-profile.md); null when missing. */
	userProfile: RpcMemoryEntry | null;
	/** All long-term memory entries (including user-profile.md). */
	memory: RpcMemoryEntry[];
}

// ============================================================================
// History Tree / Event Forensics payloads (shared with web docks)
// ============================================================================

/** A flattened history-tree node (one session), as returned by `history_tree list`. */
export interface RpcHistoryTreeNode {
	session_id: string;
	thread_id: string;
	name?: string;
	created_at: number;
	created_by: string;
	parent_session_id?: string;
	depth: number;
	child_count: number;
	is_active: boolean;
	closed: boolean;
	snippet?: string;
	/** Event id the branch was forked at (present when it has a parent). */
	fork_at_event_id?: string;
}

/** One session's message previews, as returned by `history_tree view`. */
export interface RpcHistorySessionView {
	session_id: string;
	name?: string;
	messages: string[];
	message_count: number;
}

/** Discriminated result of the `history_tree` command by action. */
export type RpcHistoryTreeResult =
	| { action: "list"; nodes: RpcHistoryTreeNode[] }
	| { action: "view"; view: RpcHistorySessionView | null }
	| { action: "jump"; session_id: string; reopened: boolean }
	| { action: "fork"; session_id: string }
	| { action: "rename"; ok: boolean };

/** A raw event projected for the timeline dock. */
export interface RpcForensicEvent {
	event_id: string;
	type: string;
	timestamp: number;
	actor_id: string;
	caused_by?: string;
	thread_id?: string;
	payload: unknown;
}

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
	| { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Typed events (stdout, raw EventBase forwarded by the bridge)
// ============================================================================

export interface TypedEvent {
	type: string;
	event_id: string;
	payload: unknown;
	[key: string]: unknown;
}

// ============================================================================
// Scheduler push events (stdout, forwarded by the bridge as rpc_event)
// ============================================================================

export const SCHEDULED_TASK_FIRED = "SCHEDULED_TASK_FIRED";
export const SCHEDULED_TASK_COMPLETED = "SCHEDULED_TASK_COMPLETED";

/** Live pipeline updates for the codegen RightDock panel. */
export const CODEGEN_STATE = "CODEGEN_STATE";

// ============================================================================
// Discriminator for stdout lines
// ============================================================================

export type StdoutLine =
	| { kind: "response"; data: RpcResponse }
	| { kind: "extension_ui_request"; data: RpcExtensionUIRequest }
	| { kind: "event"; data: TypedEvent };

export function classifyLine(raw: Record<string, unknown>): StdoutLine {
	if (raw.type === "response") {
		return { kind: "response", data: raw as unknown as RpcResponse };
	}
	if (raw.type === "extension_ui_request") {
		return { kind: "extension_ui_request", data: raw as unknown as RpcExtensionUIRequest };
	}
	return { kind: "event", data: raw as unknown as TypedEvent };
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Protocol version
// ============================================================================

export const PROTOCOL_VERSION = 1;
