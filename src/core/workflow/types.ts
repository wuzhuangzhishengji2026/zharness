/**
 * 动态工作流(SOP kind: dynamic)的类型定义。
 *
 * 模型对齐 ZCode 的 CreateWorkflow:一份 TypeScript 脚本以声明式 facade
 * 编排多个子代理会话。脚本内可用面(由 engine 注入,脚本不 import):
 *
 *   agent(name?, persona?)  创建/获取一个持久上下文的子代理,ask() 派任务
 *   ask(instructions, {of}) 派一个任务;of 指向脚本内 interface 声明时,
 *                           子代理按 JSON 契约应答,引擎解析为对象
 *   phase(name)             标记运行阶段(进度与日志按阶段归组)
 *   log(message)            输出一条人读的进度消息
 *   report(item, tag?)      落一条渐进结果(运行失败也会随通知交付)
 *   world.run(cmd, args)    确定性闸门:退出码是值,不是异常
 *   files.glob / files.read 脚本自身分片/分支所需的只读世界访问
 *   git.changedFiles(base?) 变更文件清单(扇出对象)
 *   artifact.file/markdown  发布用户可打开的产物卡片
 *   args                    启动参数(启动前已按 SOP 声明校验/填默认)
 */

/** 运行状态。errored(脚本自身失败)与 stopped(被中止)不同:stopped 可续。 */
export type WorkflowRunStatus = "running" | "completed" | "errored" | "stopped";

/** ask() 的可选项。 */
export interface WorkflowAskOptions {
	/**
	 * 结果接口名:脚本内以 `interface X { ... }` 声明的类型。给出后子代理
	 * 必须以 JSON 返回该形状,引擎解析为对象;缺省则原样返回文本。
	 */
	of?: string;
}

/** 一个持久上下文的子代理。同一 agent 的 ask 串行排队(FIFO),上下文累积。 */
export interface WorkflowAgent {
	ask<T = string>(instructions: string, options?: WorkflowAskOptions): Promise<T>;
}

/** world.run 的返回:非零退出码是值,交给脚本分支,不抛异常。 */
export interface WorkflowCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface WorkflowWorld {
	/**
	 * 运行一条确定性命令。command 必须是字面量命令名(用户批准的是脚本的
	 * 命令集);路径/参数放进 args。spawn 失败或超时才 reject。
	 */
	run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<WorkflowCommandResult>;
}

/** 脚本自身的只读世界访问(子代理有自己的工具,这里只做脚本级分片/分支)。 */
export interface WorkflowFiles {
	/** 工作区相对路径清单(排序后),匹配过多直接拒绝而非截断。 */
	glob(pattern: string): Promise<string[]>;
	/** 读一个文本文件(工作区内,带大小上限)。 */
	read(path: string): Promise<string>;
}

export interface WorkflowGit {
	/** 相对 base 的变更文件(工作区相对路径);不在 git 仓库时 reject。 */
	changedFiles(base?: string): Promise<string[]>;
}

export interface WorkflowArtifactOptions {
	/** 卡片标题(用户读)。 */
	title?: string;
	/** 标题旁的一句话说明。 */
	description?: string;
	/** 多个产物时的主交付物标记。 */
	primary?: boolean;
}

/** 产物卡片:运行期间与结束后用户都能打开的东西。 */
export interface WorkflowArtifacts {
	/** 发布一个已存在于工作区的文件。 */
	file(id: string, path: string, options?: WorkflowArtifactOptions): Promise<void>;
	/** 把 markdown 内容写进 out/sop-runs/<runId>/<id>.md 并发布。 */
	markdown(id: string, content: string, options?: WorkflowArtifactOptions): Promise<void>;
}

/** 引擎注入脚本的完整 facade。 */
export interface WorkflowFacade {
	agent: (name?: string, persona?: string | { system?: string }) => WorkflowAgent;
	log: (message: string) => void;
	phase: (name: string) => void;
	report: (item: unknown, tag?: string) => void;
	world: WorkflowWorld;
	files: WorkflowFiles;
	git: WorkflowGit;
	artifact: WorkflowArtifacts;
	args: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 执行器注入(engine 与具体子代理/命令实现解耦,便于测试)
// ============================================================================

/** 派给子代理执行器的一个任务。 */
export interface SubagentAskRequest {
	runId: string;
	/** 稳定 actor 标识(name 或匿名序号);执行器按它维持持久上下文。 */
	actorId: string;
	/** 用户可见的子代理名(日志/UI 用)。 */
	actorName: string;
	/** 该 actor 的首个任务(执行器可借此注入角色设定)。 */
	isFirstAsk: boolean;
	/** 引擎已组装完毕的完整指令(含 JSON 契约)。 */
	instructions: string;
	timeoutMs: number;
}

/**
 * 子代理执行器:接收一个任务,返回子代理的最终回复文本。
 * 同一 actorId 的任务由引擎保证串行;执行器负责让上下文跨任务延续。
 */
export interface SubagentExecutor {
	ask(request: SubagentAskRequest): Promise<string>;
	/** 释放某个 actor 的持久上下文。 */
	dispose(actorId: string): Promise<void>;
	/** 释放全部上下文(运行结束时调用)。 */
	disposeAll(): Promise<void>;
}

/** 命令执行器(world.run / git 的底层)。 */
export interface WorkflowCommandExecutor {
	run(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<WorkflowCommandResult>;
}

// ============================================================================
// 运行结果与产物
// ============================================================================

/** 一条 report() 渐进结果。 */
export interface WorkflowReportItem {
	item: unknown;
	tag?: string;
}

/** 一个已发布的产物。 */
export interface WorkflowArtifactRecord {
	id: string;
	kind: "file" | "markdown";
	/** 工作区相对路径。 */
	path: string;
	title?: string;
	description?: string;
	primary?: boolean;
}

/** 运行的最终结局(含失败:渐进结果与产物随结局一并交付)。 */
export interface WorkflowRunOutcome {
	runId: string;
	slug: string;
	name: string;
	status: WorkflowRunStatus;
	/** 脚本 return 的值(completed 时)。 */
	result?: unknown;
	/** errored/stopped 时的原因。 */
	error?: string;
	/** stopped 的原因分类。 */
	stopReason?: "user" | "model";
	reports: WorkflowReportItem[];
	artifacts: WorkflowArtifactRecord[];
	phases: string[];
	startedAt: number;
	endedAt: number;
	/** 汇报给人的一句话总结(优先取脚本 return 的 conclusion 字段)。 */
	conclusion: string;
}

/** 进度事件(onEvent 回调;扩展据此更新 UI 状态行)。 */
export type WorkflowProgressEvent =
	| { type: "phase"; name: string }
	| { type: "log"; message: string }
	| { type: "ask_started"; actorName: string }
	| { type: "ask_completed"; actorName: string; ms: number }
	| { type: "ask_failed"; actorName: string; error: string }
	| { type: "command"; command: string; exitCode: number }
	| { type: "report"; tag?: string }
	| { type: "artifact"; id: string };
