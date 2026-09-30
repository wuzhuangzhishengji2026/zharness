/**
 * Agent-side RPC types — re-exports the dependency-free protocol types
 * from @zharness/protocol and provides typed overrides for fields that
 * reference agent internals (AgentMessage, CompactionResult, etc.).
 */

export {
	type RpcCommand,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcCommandType,
	type TypedEvent,
	type StdoutLine,
	type ModelInfo,
	type ThinkingLevel,
	type RpcHistoryTreeNode,
	type RpcHistorySessionView,
	type RpcHistoryTreeResult,
	type RpcForensicEvent,
	type RpcSkillInfo,
	type RpcSopInfo,
	type RpcSopMarketEntry,
	type RpcTaskItem,
	type RpcTaskStatus,
	type RpcTaskPriority,
	type RpcTaskBoardResult,
	RpcExtensionInfo,
	RpcPersonaData,
	RpcSoulFile,
	RpcMemoryEntry,
	type RpcContextPreviewData,
	type RpcContextMessage,
	type RpcContextTool,
	type RpcContextOverridesSnapshot,
	type RpcContextScoreStatus,
	type RpcContextScoreResult,
	type RpcContextScoreDimension,
	type RpcContextScoreAnnotation,
	type RpcOverrideScope,
	type RpcAssistantSuggestion,
	type RpcAssistantSuggestionKind,
	type RpcAssistantAction,
	type RpcAssistantStateData,
	type RpcAssistantKnowledgeDraft,
	type RpcAssistantKnowledgeSaveResult,
	type RpcWorkspaceSessionSummary,
	type RpcCodegenState,
	type RpcCodegenStageRecord,
	type ScheduledTask,
	type ScheduledTaskSummary,
	type ScheduledTaskRun,
	type ScheduledTaskPatch,
	type ScheduledTaskCreateInput,
	type SchedulerPolicy,
	type ScheduleSpec,
	type ScheduleMode,
	type SessionTarget,
	type ConcurrencyPolicy,
	SCHEDULED_TASK_FIRED,
	SCHEDULED_TASK_COMPLETED,
	CODEGEN_STATE,
	classifyLine,
	PROTOCOL_VERSION,
} from "@zharness/protocol";

import type {
	RpcSessionState as ProtocolSessionState,
	RpcHistoryTreeResult,
	RpcForensicEvent,
	RpcSkillInfo,
	RpcSopInfo,
	RpcSopMarketEntry,
	RpcTaskBoardResult,
	RpcWorkspaceSessionSummary,
	RpcCodegenState,
	SchedulerPolicy,
	ScheduledTaskSummary,
	ScheduledTaskRun,
} from "@zharness/protocol";

import type { AgentMessage, ThinkingLevel } from "../../src/core/agent/types.js";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { BashResult } from "../../src/core/bash-executor.js";
import type { CompactionResult } from "../../src/core/compaction/index.js";
import type { SourceInfo } from "../../src/core/source-info.js";

// ============================================================================
// Typed overrides (agent side has full type information)
// ============================================================================

export interface RpcSessionState extends Omit<ProtocolSessionState, "model"> {
	model?: Model<any>;
}

/** Agent-side RpcSlashCommand with typed sourceInfo */
export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: SourceInfo;
}

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
	| { id?: string; type: "response"; command: "set_model"; success: true; data: Model<any> }
	| { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: Model<any>[] } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }

	// History tree / event forensics
	| { id?: string; type: "response"; command: "history_tree"; success: true; data: RpcHistoryTreeResult }
	| { id?: string; type: "response"; command: "get_events"; success: true; data: { events: RpcForensicEvent[] } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: RpcWorkspaceSessionSummary[] } }

	// Codegen pipeline (codegen-sma; RightDock panel)
	| { id?: string; type: "response"; command: "codegen"; success: true; data: { state: RpcCodegenState | null; running: boolean } }

	// Scheduled tasks (scheduler engine)
	| { id?: string; type: "response"; command: "get_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "set_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "schedule_list"; success: true; data: { tasks: ScheduledTaskSummary[] } }
	| { id?: string; type: "response"; command: "schedule_create"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_update"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_delete"; success: true; data: { ok: true; taskId: string } }
	| { id?: string; type: "response"; command: "schedule_run_now"; success: true; data: { fired: boolean; taskId: string; at: number } }
	| { id?: string; type: "response"; command: "schedule_reload"; success: true; data: { reloaded: number } }
	| { id?: string; type: "response"; command: "schedule_history"; success: true; data: { runs: ScheduledTaskRun[] } }

	// Task board (task-board built-in extension; per-workspace kanban)
	| { id?: string; type: "response"; command: "task_board"; success: true; data: RpcTaskBoardResult }

	// Task replay (read-only)
	| { id?: string; type: "response"; command: "get_replay_summary"; success: true; data: { sessionId: string; summary: unknown | null } }
	| { id?: string; type: "response"; command: "list_replay_dir"; success: true; data: { path: string; entries: Array<{ name: string; dir: boolean; size: number }> } }
	| { id?: string; type: "response"; command: "read_replay_file"; success: true; data: { name: string; mime: string; size: number; data: string } }
	// Approval (safe mode)
	| { id?: string; type: "response"; command: "approve"; success: true }
	| { id?: string; type: "response"; command: "reject"; success: true }
	| { id?: string; type: "response"; command: "set_safe_mode"; success: true; data: { safeMode: boolean } }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { sessionId: string } }
	| { id?: string; type: "response"; command: "get_skills"; success: true; data: { skills: RpcSkillInfo[] } }
	| { id?: string; type: "response"; command: "install_skill"; success: true; data: { slug: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "sop_list"; success: true; data: { sops: RpcSopInfo[] } }
	| { id?: string; type: "response"; command: "sop_market"; success: true; data: { entries: RpcSopMarketEntry[] } }
	| { id?: string; type: "response"; command: "sop_install"; success: true; data: { slug: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "sop_uninstall"; success: true; data: { slug: string; ok: boolean; message: string } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };
