/**
 * Built-in extension: skins —— 换肤插件。
 *
 * GUI 之外的三条入口共用一份皮肤数据（store.ts，<agentDir>/skins/skins.json）：
 *
 * 1. `skin` agent 工具 —— LLM 可在会话中列皮肤 / 换肤 / 调遮罩，
 *    例如「换个护眼的绿色主题」。
 * 2. `/skins` 斜杠命令 —— TUI/RPC 会话里人工换肤
 *    （list / use / dim / blur / off）。
 * 3. GUI 设置页皮肤库 —— Web 前端经 `skin_state` / `skin_apply` /
 *    `skin_add` / `skin_remove` / `skin_image` / `skin_rename` RPC 读写
 *    （协议见 packages/protocol，分发见 packages/rpc/rpc-mode.ts）。
 *
 * 变更后向 EventStore 追加 CUSTOM_MESSAGE(display:false,
 * kind=skin_changed) 事件，GUI 订阅刷新；聊天流不渲染。
 *
 * 应用层（Web 前端）负责把皮肤翻译成 CSS 变量 / 背景图层；本扩展只做
 * 目录、持久化与校验。
 */

import { Type } from "@sinclair/typebox";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import type { EventAppendInput } from "../../core/event-store/store.js";
import {
	addCustomSkin,
	applySkin,
	getSkinState,
	listBuiltinSkins,
	renameCustomSkin,
	removeCustomSkin,
	type Skin,
} from "./store.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const SKINS_EXTENSION_ID = "skins";

/** 事件接收面：EventStore 与 facade.runtime.store 都满足该形状。 */
interface AppendOnlyStore {
	append(event: EventAppendInput): unknown;
}

/** 追加一条皮肤变更事件（display:false，GUI 订阅刷新，聊天流不渲染）。 */
export function emitSkinChanged(store: AppendOnlyStore | undefined, summary: string): void {
	if (!store) return;
	try {
		store.append({
			actor_id: "skins",
			type: "CUSTOM_MESSAGE",
			payload: {
				extension_id: SKINS_EXTENSION_ID,
				kind: "skin_changed",
				data: summary,
				display: false,
			},
		});
	} catch {
		// 事件库不可用时静默降级 —— 皮肤数据已落盘，事件只是刷新提示。
	}
}

/** 皮肤的一行摘要（命令输出用）。 */
function formatSkinLine(skin: Skin, activeId: string): string {
	const mark = skin.id === activeId ? "●" : "○";
	const tag = skin.kind === "builtin" ? "内置" : "自定义";
	const desc = skin.description ? ` — ${skin.description}` : "";
	return `  ${mark} ${skin.name} (${skin.id}) [${tag}]${desc}`;
}

function formatSkinList(activeId: string): string {
	const builtins = listBuiltinSkins();
	const customs = getSkinState().skins.filter((s) => s.kind === "custom");
	const active = activeId === "default" ? "默认 (default)" : activeId;
	return [
		`当前皮肤：${active}`,
		"内置皮肤：",
		...builtins.map((s) => formatSkinLine(s, activeId)),
		...(customs.length > 0 ? ["自定义皮肤：", ...customs.map((s) => formatSkinLine(s, activeId))] : []),
	].join("\n");
}

const USAGE = `Usage:
  /skins list                列出可用皮肤
  /skins use <id>            启用皮肤（default/sakura/forest/sunset/aurora/deepsea 或自定义 id）
  /skins dim <0-90>          调节自定义图片皮肤的遮罩浓度（百分比）
  /skins blur <0-12>         调节自定义图片皮肤的背景模糊（px）
  /skins add <名称>          提示：自定义图片皮肤请在 GUI 设置页上传
  /skins remove <id>         删除自定义皮肤
  /skins off                 恢复默认皮肤
  /skins help                显示本帮助

GUI 设置页「皮肤」卡片与本命令共用同一份数据。`;

export const createSkinsExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	// ------------------------------------------------------------------
	// Agent 工具：让 LLM 在会话内换肤
	// ------------------------------------------------------------------
	zharness.registerTool({
		name: "skin",
		label: "Skin",
		description:
			"Switch the GUI color theme / background skin (persistent app preference). Actions: " +
			"'list' returns available skins (builtin color palettes + custom image skins); " +
			"'use' activates a skin by id; 'remove' deletes a custom skin. " +
			"Use this when the user asks to change the app theme/appearance, e.g. 「换个护眼的主题」.",
		promptSnippet: "skin: list/switch the app skin (color themes & custom background images)",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("use"), Type.Literal("remove")]),
			id: Type.Optional(Type.String({ description: "Skin id (required for use/remove)" })),
			dim: Type.Optional(Type.Number({ description: "Custom image skin mask opacity 0-0.9 (with use)" })),
			blur: Type.Optional(Type.Number({ description: "Custom image skin blur px 0-12 (with use)" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const store = ctx.sessionManager.eventStore;
			switch (params.action) {
				case "list": {
					const state = getSkinState();
					return {
						content: [{ type: "text", text: formatSkinList(state.activeSkinId) }],
						details: state,
					};
				}
				case "use": {
					if (!params.id?.trim()) {
						throw new Error("skin use: id is required (action=list 查看 id)");
					}
					const skin = applySkin(params.id.trim(), { dim: params.dim, blur: params.blur });
					if (!skin) {
						return {
							content: [{ type: "text", text: `未找到皮肤 ${params.id}（action=list 查看可用皮肤）。` }],
						};
					}
					emitSkinChanged(store, `启用皮肤：${skin.name}`);
					return {
						content: [{ type: "text", text: `已启用皮肤「${skin.name}」（${skin.id}）。GUI 会立即换装。` }],
						details: { skin },
					};
				}
				case "remove": {
					if (!params.id?.trim()) {
						throw new Error("skin remove: id is required");
					}
					const removed = removeCustomSkin(params.id.trim());
					if (removed) emitSkinChanged(store, `删除自定义皮肤：${params.id}`);
					return {
						content: [{ type: "text", text: removed ? `已删除自定义皮肤 ${params.id}。` : `未找到自定义皮肤 ${params.id}（内置皮肤不可删除）。` }],
						details: { removed },
					};
				}
			}
		},
	});

	// ------------------------------------------------------------------
	// 斜杠命令：人工换肤
	// ------------------------------------------------------------------
	zharness.registerCommand("skins", {
		description: "换肤插件：列出并切换 GUI 皮肤（内置色板 + 自定义图片，与 GUI 设置页同一份数据）。",
		getArgumentCompletions: (argumentPrefix) => {
			const subs = ["list", "use", "dim", "blur", "add", "remove", "off", "help"];
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			if (argumentPrefix.includes(" ")) return null;
			return subs.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const subcommand = (trimmed.split(/\s+/)[0] || "help").toLowerCase();
			const rest = trimmed.slice(subcommand.length).trim();
			const store = ctx.sessionManager.eventStore;
			const notify = (message: string, type?: "info" | "warning" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, type ?? "info");
				else console.log(message);
			};

			switch (subcommand) {
				case "list": {
					notify(formatSkinList(getSkinState().activeSkinId));
					return;
				}
				case "use": {
					if (!rest) {
						notify("缺少皮肤 id。用法：/skins use <id>（/skins list 查看）", "warning");
						return;
					}
					const skin = applySkin(rest);
					if (!skin) {
						notify(`未找到皮肤 ${rest}（/skins list 查看可用皮肤）`, "warning");
						return;
					}
					emitSkinChanged(store, `启用皮肤：${skin.name}`);
					notify(`已启用皮肤「${skin.name}」（${skin.id}）。`, "info");
					return;
				}
				case "dim":
				case "blur": {
					const value = Number(rest);
					if (!rest || Number.isNaN(value)) {
						notify(`用法：/skins ${subcommand} <数值>（${subcommand === "dim" ? "0-90 百分比" : "0-12 px"}）`, "warning");
						return;
					}
					const state = getSkinState();
					const active = state.skins.find((s) => s.id === state.activeSkinId);
					if (!active?.image) {
						notify("当前皮肤不是自定义图片皮肤，无法调节。", "warning");
						return;
					}
					const skin = applySkin(active.id, subcommand === "dim" ? { dim: value / 100 } : { blur: value });
					emitSkinChanged(store, `调节皮肤：${skin?.name ?? active.id}`);
					notify(skin ? `已调节「${skin.name}」的${subcommand === "dim" ? "遮罩浓度" : "背景模糊"}。` : "调节失败。", "info");
					return;
				}
				case "add": {
					notify("自定义图片皮肤请在 GUI 设置页「皮肤」卡片上传图片（支持 PNG/JPG/WebP/GIF）。", "info");
					return;
				}
				case "remove": {
					if (!rest) {
						notify("缺少皮肤 id。用法：/skins remove <id>", "warning");
						return;
					}
					const removed = removeCustomSkin(rest);
					if (removed) emitSkinChanged(store, `删除自定义皮肤：${rest}`);
					notify(removed ? `已删除自定义皮肤 ${rest}。` : `未找到自定义皮肤 ${rest}（内置皮肤不可删除）。`, removed ? "info" : "warning");
					return;
				}
				case "off": {
					const skin = applySkin("default");
					emitSkinChanged(store, "恢复默认皮肤");
					notify(skin ? "已恢复默认皮肤。" : "恢复失败。", "info");
					return;
				}
				case "help":
				default: {
					notify(USAGE);
					return;
				}
			}
		},
	});
};
