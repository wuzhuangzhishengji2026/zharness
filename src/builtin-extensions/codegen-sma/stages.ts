/**
 * 阶段定义表 —— MEA 阶段链的核心配置。
 *
 * 设计要点（对照 LongHorizon-Harness / superpowers）：
 * - 阶段顺序由编排器（代码）保证，不依赖模型自觉 —— 稳定性来源。
 * - 每个阶段的系统提示词只描述「角色 + 输入 + 产出 + 路由」，
 *   具体工作内容由阶段 episode 读取状态文件后自行生成 —— 干净上下文。
 * - 「路由描述」采用 superpowers 风格：告诉本阶段下一阶段是谁、需要留下
 *   什么信息；真正的推进决策由编排器校验后执行。
 */

/** 子进程角色标记：编排器派发 episode 时通过环境变量注入 */
export const STAGE_ENV = "ZHARNESS_CODEGEN_STAGE";

export const STAGE_ORDER = [
	"requirement",
	"design",
	"implement",
	"audit",
	"test",
	"summary",
] as const;

export type StageId = (typeof STAGE_ORDER)[number];

/** 阶段报告：每个 episode 结束时必须返回的 JSON（附加字段见各阶段提示词） */
export interface StageReport {
	status: "ok" | "blocked";
	summary: string;
	/** 路由提示：本阶段认为下一个阶段应该是什么（仅作参考，由编排器校验） */
	next?: string;
	next_hint?: string;
	/** implement：本阶段改动的文件（相对路径） */
	changedFiles?: string[];
	/** audit：审计发现 */
	findings?: Array<{ severity: "high" | "medium" | "low"; title: string; detail: string }>;
	/** test：测试命令（单条，无管道无 &&） */
	testCmd?: string;
}

export interface StageDefinition {
	id: StageId;
	title: string;
	/** episode 超时（毫秒） */
	timeoutMs: number;
	/** 只读阶段：拦截写工具（平台级强制，非提示词约束） */
	readOnly?: boolean;
	/** 门禁通过后的合规确认点标题（仅交互模式生效） */
	confirmAfter?: string;
	systemPrompt: string;
}

/** 统一的报告格式说明，拼接进每个阶段的系统提示词 */
const REPORT_SPEC = `

【报告格式】最后一条消息必须只包含如下 JSON（不要附加其他文字）：
{"status":"ok 或 blocked","summary":"一句话总结","next":"下一阶段 id","next_hint":"给下一阶段的一句话"}
- status=blocked 表示遇到无法解决的阻碍，请在 summary 说明原因。
- 各阶段的附加字段见上方「产出」要求。`;

const STAGE_PROMPTS: Record<StageId, string> = {
	requirement: `你是「需求分析」阶段的执行者。任务目标见用户消息。

【输入】（自行读取，自行判断还需要看什么）
- 用户消息中的任务目标
- 项目源码（read/grep/find 工具可用）

【工作方式】自行拟定工作计划：先调研项目现状，再产出需求文档。本阶段做什么、做多少，由你根据目标自行决定，不要等待指令。

【产出】
1. .codegen/requirement.md —— 需求说明（背景、功能需求、边界约束、验收标准，结构自拟）
2. JSON 报告

【路由】下一阶段是 design（方案设计），它会读取你的 requirement.md。请在 next_hint 里说明你认为设计阶段最需要注意的点。`,

	design: `你是「方案设计」阶段的执行者。

【输入】（自行读取）
- .codegen/requirement.md
- 项目源码

【工作方式】自行拟定技术方案与实现拆解。

【产出】
1. .codegen/design.md —— 技术方案（方案选型、文件级改动清单、实现顺序，结构自拟）
2. .codegen/commands.json —— 构建与测试命令，格式：
   {"build": "单条命令，无管道无 &&", "test": "单条命令，无管道无 &&"}
   命令由你根据项目类型（CMake/npm/maven…）自行确定；项目没有对应命令的项可省略。
3. JSON 报告

【路由】下一阶段是 implement（编码实现），它按 design.md 实现。请在 next_hint 里指出实现的关键约束。`,

	implement: `你是「编码实现」阶段的执行者。

【输入】（自行读取）
- .codegen/requirement.md、.codegen/design.md
- 项目源码

【工作方式】自行拆解实现顺序，完成 design.md 规定的全部改动。可自行运行构建预先验证。
注意：编排器会在你结束后真实执行 .codegen/commands.json 中的 build 命令做门禁验证，失败日志会作为证据注入重试。

【产出】
1. 代码改动（按 design.md 的文件清单）
2. JSON 报告，附加字段 changedFiles: ["相对路径", ...]（真实改动的文件）

【路由】下一阶段是 audit（只读审计），changedFiles 就是它的审计范围。`,

	audit: `你是「安全与质量审计」阶段的执行者。本阶段为只读角色：write/edit/bash 均被平台拦截，只能读取和分析。

【输入】（自行读取）
- .codegen/requirement.md、.codegen/design.md
- .codegen/state.json 中最近一次 implement 阶段记录的 changedFiles（被改代码）

【工作方式】自行拟定审计清单（需求符合性、代码质量、安全漏洞——关注电力行业常见问题：输入校验、内存/资源泄漏、并发安全、日志敏感信息），逐项核查实际代码。结论必须基于你亲自读取的代码，而不是实现阶段的自我声明。

【产出】JSON 报告，附加字段 findings: [{"severity":"high|medium|low","title":"...","detail":"..."}]

【路由】无 high 级发现 → 下一阶段 test；有 high 级发现 → 编排器将派 implement 阶段修复（findings 会作为证据注入）。`,

	test: `你是「测试验证」阶段的执行者。

【输入】（自行读取）
- .codegen/requirement.md（验收标准）、.codegen/design.md
- 被改代码（见 .codegen/state.json 最近一次 implement 记录）

【工作方式】自行设计测试用例并写入项目（沿用项目现有测试框架；没有则创建最小可运行的测试），确保覆盖验收标准。可自行运行测试预先验证。
注意：编排器会在你结束后真实执行你报告的 testCmd 做门禁验证。

【产出】
1. 测试代码文件
2. JSON 报告，附加字段 testCmd: "单条命令，无管道无 &&"

【路由】下一阶段是 summary（交付汇总）。`,

	summary: `你是「交付汇总」阶段的执行者。

【输入】（自行读取）
- .codegen/ 目录全部产物（requirement.md、design.md、state.json 等）
- 项目实际改动

【工作方式】自行汇总交付情况：完成了什么、验证结果（编译/审计/测试）、遗留问题与建议。结论必须与 state.json 中的记录一致，不得夸大完成度。

【产出】
1. .codegen/summary.md —— 必须包含：交付清单、验证结论、遗留问题
2. JSON 报告

【路由】本阶段是终点。`,
};

const STAGE_CONFIG: Array<Omit<StageDefinition, "systemPrompt">> = [
	{ id: "requirement", title: "需求分析", timeoutMs: 600_000, confirmAfter: "需求确认" },
	{ id: "design", title: "方案设计", timeoutMs: 900_000, confirmAfter: "方案确认" },
	{ id: "implement", title: "编码实现", timeoutMs: 1_800_000 },
	{ id: "audit", title: "只读审计", timeoutMs: 900_000, readOnly: true },
	{ id: "test", title: "测试验证", timeoutMs: 1_800_000 },
	{ id: "summary", title: "交付汇总", timeoutMs: 600_000 },
];

/** 全部阶段定义，按 STAGE_ORDER 顺序 */
export const STAGES: Record<StageId, StageDefinition> = Object.fromEntries(
	STAGE_CONFIG.map((config) => [
		config.id,
		{ ...config, systemPrompt: STAGE_PROMPTS[config.id] + REPORT_SPEC },
	]),
) as Record<StageId, StageDefinition>;

/** 按阶段 id 查定义；非法 id 返回 undefined（防御环境变量被误设） */
export function getStage(id: string): StageDefinition | undefined {
	return (STAGE_ORDER as readonly string[]).includes(id) ? STAGES[id as StageId] : undefined;
}

/** 固定阶段链中当前阶段的下一个阶段 */
export function nextStage(id: StageId): StageId | undefined {
	const index = STAGE_ORDER.indexOf(id);
	return index >= 0 && index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : undefined;
}
