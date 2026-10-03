/**
 * Web app types — re-exports shared protocol types from @zharness/protocol
 * and adds web-specific types (WorkspaceMeta, AgentMessage subset).
 */

export {
	type RpcCommand,
	type RpcResponse,
	type RpcSessionState,
	type RpcContextUsage,
	type RpcTokenUsage,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcCommandType,
	type TypedEvent,
	type StdoutLine,
	type ModelInfo,
	type ThinkingLevel,
	type RpcSlashCommand,
	type RpcHistoryTreeNode,
	type RpcHistorySessionView,
	type RpcHistoryTreeResult,
	type RpcForensicEvent,
	type RpcTaskItem,
	type RpcTaskStatus,
	type RpcTaskPriority,
	type RpcTaskBoardResult,
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
	type RpcSkin,
	type RpcSkinState,
	type RpcSkinImage,
	type RpcPet,
	type RpcPetView,
	type RpcPetRarity,
	type RpcBlindBoxDraw,
	type RpcHatchResult,
	type RpcPetInteractResult,
	type RpcPetsState,
	classifyLine,
	PROTOCOL_VERSION,
} from "@zharness/protocol";

// ---- AgentMessage (subset, for get_messages) ----
export interface AgentMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

// ---- Workspace metadata (from ~/.zharness/agent/workspaces/*/meta.json) ----
export interface WorkspaceMeta {
	workspace_id: string;
	cwd: string;
	created_at: number;
	last_accessed_at: number;
}
