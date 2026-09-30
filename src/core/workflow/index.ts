/**
 * 动态工作流(SOP kind: dynamic)运行时入口。
 *
 * - types.ts:facade 与执行器接口(脚本作者视角的 API 契约)
 * - interfaces.ts:interface 声明提取(typed ask 的 JSON 契约)
 * - engine.ts:编排引擎(journal/并发/中止/运行注册表)
 * - agent-executor.ts:RpcClient 子代理执行器(生产实现)
 */

export type {
	WorkflowAgent,
	WorkflowArtifactOptions,
	WorkflowArtifactRecord,
	WorkflowAskOptions,
	WorkflowCommandResult,
	WorkflowFacade,
	WorkflowFiles,
	WorkflowGit,
	WorkflowProgressEvent,
	WorkflowReportItem,
	WorkflowRunOutcome,
	WorkflowRunStatus,
	WorkflowWorld,
	WorkflowCommandExecutor,
	SubagentAskRequest,
	SubagentExecutor,
} from "./types.js";

export {
	extractInterfaces,
	extractJsonResult,
} from "./interfaces.js";

export {
	createDefaultCommandExecutor,
	getWorkflowRunSummary,
	getWorkflowRunsRoot,
	listWorkflowRuns,
	startWorkflowRun,
	stopWorkflowRun,
	validateWorkflowArgs,
	type WorkflowEngineOptions,
	type WorkflowRunHandle,
	type WorkflowRunSummary,
	type StartWorkflowOptions,
} from "./engine.js";

export { createRpcSubagentExecutor, type RpcSubagentExecutorOptions } from "./agent-executor.js";
