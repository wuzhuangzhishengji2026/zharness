/**
 * Scheduler public API (ported from the zharness fusion).
 *
 * Re-exports the types and helpers needed by:
 *   - packages/rpc/rpc-mode.ts (engines + dispatcher + RPC handlers)
 *   - apps/web (transitively, via transport.ts)
 *
 * Internal modules are intentionally NOT re-exported to keep the surface
 * small. Add new entries here as the API grows.
 */

export {
	SchedulerEngine,
	nextRunAt,
	nextNRuns,
	unsupportedSessionTargetReason,
	isScopeEngineAlive,
	type Dispatcher,
	type SchedulerEngineOptions,
	type SchedulerEngineEvents,
	type SchedulerListener,
} from "./engine.js";

export {
	parseCron,
	validateCron,
	specToCron,
	cronToSpec,
	cronNextRun,
} from "./cron.js";

export {
	readTasks,
	readTasksChecked,
	readTaskFresh,
	readTaskFreshChecked,
	recoverTasksFile,
	writeTasks,
	appendRun,
	readRuns,
	readTasksAllScopes,
	mutateTaskAnyScope,
	getSchedulerDir,
	readWorkspaceCwd,
	type ScopedTask,
	type ReadTasksResult,
	type FreshTaskResult,
} from "./store.js";

export { SchedulerScopeLock, HEARTBEAT_MS, STALE_MS } from "./scope-lock.js";

export {
	generateTaskId,
	defaultTaskName,
	validateScheduleSpec,
	SCHEDULE_MIN_INTERVAL_N,
	SCHEDULE_MAX_INTERVAL_N,
	SCHEDULE_NAME_MAX,
} from "./types.js";

export type {
	ScheduledTask,
	ScheduledTaskSummary,
	ScheduledTaskRun,
	ScheduleSpec,
	ScheduleMode,
	TimeOfDay,
	Weekday,
	DayOfMonth,
} from "@zharness/protocol";
