/**
 * 确定性门禁：由代码直接检验环境真相，不采信 episode 的自我声明。
 *
 * - 文件类门禁：直接检查磁盘（存在 + 非空）。
 * - 构建类门禁：真实执行 .codegen/commands.json 中的命令（由 design
 *   阶段自行生成），以退出码为准。
 * - 门禁失败 → 证据（日志尾部）注入同阶段重试 —— LongHorizon-Harness
 *   的失败恢复语义：失败是下一轮的输入，不是终点。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execCommand } from "../../core/exec.js";
import type { StageId, StageReport } from "./stages.js";

export interface GateResult {
	passed: boolean;
	/** 通过说明或失败证据（失败时注入重试） */
	evidence: string;
	/** 失败时应重试的阶段：默认重试本阶段；审计发现 high 问题时回退 implement */
	retryStage?: StageId;
}

/** 构建命令超时 */
const BUILD_TIMEOUT_MS = 600_000;
/** 测试命令超时 */
const TEST_TIMEOUT_MS = 900_000;
/** 注入重试证据的日志尾部最大长度 */
const LOG_TAIL_CHARS = 2_000;

function tail(text: string, max = LOG_TAIL_CHARS): string {
	return text.length > max ? `…${text.slice(-max)}` : text;
}

/** 文件存在且非空 */
function nonEmptyFile(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
}

/** 读 .codegen/commands.json（design 阶段自生成的构建/测试命令） */
function readCommands(codegenDir: string): { build?: string; test?: string } {
	try {
		return JSON.parse(readFileSync(join(codegenDir, "commands.json"), "utf-8"));
	} catch {
		return {};
	}
}

/**
 * 将命令字符串拆为 {command, args}。仅接受单条可直接执行的命令；
 * 含 shell 语法（管道/重定向/&&）时返回 null，由门禁报错重试。
 */
function parseCommand(cmd: string): { command: string; args: string[] } | null {
	if (/[|><;&]/.test(cmd)) return null;
	const parts = cmd.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return null;
	return { command: parts[0], args: parts.slice(1) };
}

/** 真实执行一条命令并以退出码判定 */
async function runCommand(
	cmd: string,
	cwd: string,
	timeoutMs: number,
): Promise<GateResult> {
	const parsed = parseCommand(cmd);
	if (!parsed) {
		return {
			passed: false,
			evidence: `命令包含 shell 语法（管道/重定向/&&），必须是单条可直接执行的命令：${cmd}`,
		};
	}
	const result = await execCommand(parsed.command, parsed.args, cwd, { timeout: timeoutMs });
	const output = tail(`${result.stdout}\n${result.stderr}`.trim());
	return result.code === 0
		? { passed: true, evidence: `命令执行成功：${cmd}` }
		: { passed: false, evidence: `命令失败（退出码 ${result.code}）：${cmd}\n${output}` };
}

/** 各阶段门禁表 */
const GATES: Record<StageId, (cwd: string, report: StageReport | null) => Promise<GateResult>> = {
	async requirement(cwd) {
		return nonEmptyFile(join(cwd, ".codegen", "requirement.md"))
			? { passed: true, evidence: "requirement.md 已生成" }
			: { passed: false, evidence: ".codegen/requirement.md 不存在或为空" };
	},

	async design(cwd) {
		if (!nonEmptyFile(join(cwd, ".codegen", "design.md"))) {
			return { passed: false, evidence: ".codegen/design.md 不存在或为空" };
		}
		const commands = readCommands(join(cwd, ".codegen"));
		if (!commands.build && !commands.test) {
			// 项目可能确实没有构建/测试命令；允许通过但留下证据，编译门禁将跳过
			return { passed: true, evidence: "design.md 已生成；commands.json 未提供 build/test，编译与测试门禁将跳过" };
		}
		return { passed: true, evidence: "design.md 与 commands.json 已生成" };
	},

	async implement(cwd, report) {
		// 门禁 1：报告的改动文件真实存在且非空
		const files = report?.changedFiles ?? [];
		if (files.length === 0) {
			return { passed: false, evidence: "报告缺少 changedFiles（须为非空数组，列出真实改动的相对路径）" };
		}
		const missing = files.filter((f) => !nonEmptyFile(join(cwd, f)));
		if (missing.length > 0) {
			return { passed: false, evidence: `以下文件不存在或为空：${missing.join(", ")}` };
		}
		// 门禁 2：真实执行构建（commands.json 未提供则跳过）
		const { build } = readCommands(join(cwd, ".codegen"));
		if (!build) {
			return { passed: true, evidence: `改动文件就绪（${files.length} 个）；无 build 命令，编译门禁跳过` };
		}
		return runCommand(build, cwd, BUILD_TIMEOUT_MS);
	},

	async audit(_cwd, report) {
		if (!report) {
			return { passed: false, evidence: "审计报告不可解析（最后一条消息必须是纯 JSON）" };
		}
		const highs = (report.findings ?? []).filter((f) => f.severity === "high");
		if (highs.length > 0) {
			const detail = highs.map((f) => `[${f.severity}] ${f.title}：${f.detail}`).join("\n");
			return {
				passed: false,
				evidence: `审计发现 ${highs.length} 项 high 级问题，需修复：\n${detail}`,
				retryStage: "implement",
			};
		}
		const count = report.findings?.length ?? 0;
		return { passed: true, evidence: count > 0 ? `审计通过（${count} 项非 high 级发现，已记录）` : "审计通过，无发现" };
	},

	async test(cwd, report) {
		const cmd = report?.testCmd;
		if (!cmd) {
			return { passed: false, evidence: "报告缺少 testCmd（须为单条可直接执行的测试命令）" };
		}
		return runCommand(cmd, cwd, TEST_TIMEOUT_MS);
	},

	async summary(cwd) {
		return nonEmptyFile(join(cwd, ".codegen", "summary.md"))
			? { passed: true, evidence: "summary.md 已生成" }
			: { passed: false, evidence: ".codegen/summary.md 不存在或为空" };
	},
};

/** 执行指定阶段的门禁 */
export function runGate(stage: StageId, cwd: string, report: StageReport | null): Promise<GateResult> {
	return GATES[stage](cwd, report);
}
