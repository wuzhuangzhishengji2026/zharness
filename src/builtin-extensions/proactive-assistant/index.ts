/**
 * Built-in extension: proactive-assistant —— 主动式交互助手。
 *
 * 在用户与主模型交互过程中，后台实时分析当前活跃对话：
 * - 阻塞时（连续工具失败/同一操作反复失败/回复被截断/以错误结束/上下文吃紧）
 *   主动给出可一键执行的脱困建议；
 * - 做得好时（一轮顺利完成且做了实事、全程零失败）提示用户把本次经验
 *   沉淀为长期知识（写入主 agent 记忆库，下次会话即可复用）。
 *
 * 三条原则：不打扰（display:false 事件 + 冷却 + 免打扰 + 每会话一次沉淀
 * 提议）、确定性分析（规则引擎，不额外调 LLM）、同一套扩展机制
 * （/assistant 命令 + proactive_assistant RPC + GUI 浮动小助手）。
 *
 * 设计文档见同目录 DESIGN.md；信号阈值见 analyzer.ts。
 * Enable/disable state is persisted in `settings.json` under
 * `disabledBuiltinExtensions`（同 task-board 模式，重启 sidecar 生效）。
 */

import { getAgentDir, SettingsManager } from "../../index.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import type { EventAppendInput } from "../../core/event-store/store.js";
import * as analyzer from "./analyzer.js";
import * as store from "./store.js";
import type { AssistantSuggestion } from "./types.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const PROACTIVE_ASSISTANT_EXTENSION_ID = "proactive-assistant";

/** 最近一次 hook 调用见到的 EventStore（广播 CUSTOM_MESSAGE 用）。 */
let lastKnownStore: { append(event: EventAppendInput): unknown } | undefined;

/** 最近一次 hook 调用见到的会话 id（建议归属）。 */
let lastKnownSessionId = "";

/** 广播节流：同一 tick 内合并多次变更。 */
let broadcastScheduled = false;

function scheduleBroadcast(): void {
	if (broadcastScheduled || !lastKnownStore) return;
	broadcastScheduled = true;
	// 下一拍再 append：避免在事件处理过程中同步追加深层级事件。
	setTimeout(() => {
		broadcastScheduled = false;
		const target = lastKnownStore;
		if (!target) return;
		try {
			target.append({
				actor_id: PROACTIVE_ASSISTANT_EXTENSION_ID,
				type: "CUSTOM_MESSAGE",
				payload: {
					extension_id: PROACTIVE_ASSISTANT_EXTENSION_ID,
					kind: "proactive_assistant_changed",
					data: { reason: "changed" },
					display: false,
				},
			});
		} catch {
			// 事件库不可用时静默降级——RPC 轮询仍可拿到建议。
		}
	}, 0);
}

function rememberContext(ctx: { sessionManager: { eventStore?: unknown; projection?: { getDescriptor(): { session_id: string } } } }, fallbackSessionId: string): void {
	const eventStore = ctx.sessionManager.eventStore as { append(event: EventAppendInput): unknown } | undefined;
	if (eventStore) lastKnownStore = eventStore;
	const sessionId = ctx.sessionManager.projection?.getDescriptor().session_id;
	if (sessionId) lastKnownSessionId = sessionId;
	else if (!lastKnownSessionId) lastKnownSessionId = fallbackSessionId;
}

/** 从 tool_execution_start 的 args 提取「目标指纹」（识别同一目标反复失败）。 */
function toolTargetKey(toolName: string, args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const a = args as Record<string, unknown>;
	if (toolName === "bash" && typeof a.command === "string") {
		// 只取首行命令本体：长命令的参数噪声不影响「同一操作」的判定。
		return a.command.split("\n")[0]?.slice(0, 120);
	}
	for (const key of ["path", "file_path", "filePath", "file", "pattern", "url"]) {
		if (typeof a[key] === "string") return (a[key] as string).slice(0, 120);
	}
	return undefined;
}

function formatSuggestionLine(s: AssistantSuggestion): string {
	const actions = s.actions.map((a) => a.kind).join("/");
	return `  [${s.id}] ${s.ruleId} ${s.kind} · ${s.title}（动作：${actions}）`;
}

const USAGE = `Usage:
  /assistant list                查看当前建议与状态
  /assistant clear               清空全部建议
  /assistant mute <分钟>         免打扰 N 分钟（默认 60）
  /assistant disable             禁用本内置扩展（持久化）
  /assistant enable              重新启用
  /assistant help                显示本帮助

建议由后台分析器自动产生：阻塞时给脱困建议，做得好时提示沉淀知识。
GUI 右下角浮动小助手与本命令共用同一份数据。`;

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		console.log(message);
	}
}

function persistDisabled(cwd: string, disabled: boolean): void {
	const settings = SettingsManager.create(cwd, getAgentDir());
	settings.setBuiltinExtensionDisabled(PROACTIVE_ASSISTANT_EXTENSION_ID, disabled);
}

/** 当前会话统计（/assistant list 展示 + 测试断言用）。 */
export function getAssistantStats(): {
	activeSuggestions: number;
	userTurns: number;
	muted: boolean;
	knowledgeOffered: boolean;
} {
	return {
		activeSuggestions: store.listActiveSuggestions().length,
		userTurns: store.getUserTurns(),
		muted: store.isMuted(),
		knowledgeOffered: store.hasOfferedKnowledge(),
	};
}

export const createProactiveAssistantExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	store.markProactiveAssistantLoaded();

	// 状态变更 → 广播（GUI 收到 proactive_assistant_changed 后拉取全量）。
	store.onStoreChange(() => scheduleBroadcast());

	// ------------------------------------------------------------------
	// 事件面：累积信号 → agent_end 结算
	// ------------------------------------------------------------------

	// 新的用户消息：重置轮内信号、用户轮数 +1、沉淀提议过期。
	zharness.on("before_agent_start", (event, ctx) => {
		rememberContext(ctx, "");
		store.onUserTurnStarted();
		analyzer.beginTurn();
		// 顺手把脚注状态清掉：新一轮开始了，旧建议脚注不再有意义。
		if (ctx.hasUI) ctx.ui.setStatus("assistant", undefined);
	});

	// 记住每个 toolCallId 的目标指纹（end 事件不带 args）。
	const toolTargets = new Map<string, string | undefined>();
	zharness.on("tool_execution_start", (event, ctx) => {
		rememberContext(ctx, "");
		toolTargets.set(event.toolCallId, toolTargetKey(event.toolName, event.args));
	});

	zharness.on("tool_execution_end", (event, ctx) => {
		rememberContext(ctx, "");
		store.recordToolResult(event.isError);
		analyzer.recordToolEnd(event.toolName, event.isError, toolTargets.get(event.toolCallId));
		toolTargets.delete(event.toolCallId);
	});

	zharness.on("message_end", (event, ctx) => {
		rememberContext(ctx, "");
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role === "assistant") {
			analyzer.recordStopReason(message.stopReason);
		}
	});

	// agent loop 结束：结算本轮信号，可能产出一条建议。
	zharness.on("agent_end", (_event, ctx) => {
		rememberContext(ctx, "");
		const usage = ctx.getContextUsage();
		const outcome = analyzer.currentOutcome();
		const verdict = analyzer.settle({
			outcome,
			contextPercent: usage?.percent ?? null,
			userTurns: store.getUserTurns(),
			knowledgeOffered: store.hasOfferedKnowledge(),
		});
		if (verdict.suggestion) {
			const added = store.addSuggestion(verdict.suggestion, lastKnownSessionId);
			if (added && ctx.hasUI) {
				// TUI：轻量脚注提示（GUI 走事件广播 + 浮动角标，不弹窗）。
				ctx.ui.setStatus(
					"assistant",
					`助手建议 x1（/assistant list 查看）`,
				);
			}
		}
	});

	// ------------------------------------------------------------------
	// 斜杠命令：人工入口（TUI / RPC 会话）
	// ------------------------------------------------------------------
	zharness.registerCommand("assistant", {
		description: "主动式交互助手：查看/管理当前建议（阻塞提示、知识沉淀提议）。",
		getArgumentCompletions: (argumentPrefix) => {
			const subs = ["list", "clear", "mute", "disable", "enable", "help"];
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			if (argumentPrefix.includes(" ")) return null;
			return subs.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const subcommand = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
			const rest = trimmed.slice(subcommand.length).trim();

			switch (subcommand) {
				case "list": {
					const suggestions = store.listActiveSuggestions();
					const muted = store.isMuted();
					const lines: string[] = [];
					lines.push(
						`主动式交互助手：active 建议 ${suggestions.length} 条 · 用户轮数 ${store.getUserTurns()}` +
							(muted ? ` · 免打扰至 ${new Date(store.getMutedUntil()).toLocaleTimeString()}` : ""),
					);
					if (suggestions.length === 0) {
						lines.push("  （暂无建议。阻塞或顺利完成时会自动出现。）");
					} else {
						lines.push(...suggestions.map(formatSuggestionLine));
						lines.push("  提示：建议动作（steer/compact/沉淀知识）请在 GUI 浮动小助手中执行，或按正文手动操作。");
					}
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "clear": {
					store.clearSuggestions();
					notify(ctx, "已清空全部助手建议。", "info");
					return;
				}
				case "mute": {
					const minutes = Number.parseInt(rest, 10);
					const n = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
					const until = store.mute(n);
					notify(ctx, `助手已免打扰至 ${new Date(until).toLocaleTimeString()}（/assistant mute 0 可提前解除）。`, "info");
					return;
				}
				case "disable": {
					persistDisabled(ctx.cwd, true);
					notify(ctx, "proactive-assistant 内置扩展已禁用，正在重载…", "info");
					await ctx.reload();
					return;
				}
				case "enable": {
					persistDisabled(ctx.cwd, false);
					notify(ctx, "proactive-assistant 内置扩展已启用，正在重载…", "info");
					await ctx.reload();
					return;
				}
				case "help":
				default: {
					notify(ctx, USAGE, "info");
					return;
				}
			}
		},
	});
};
