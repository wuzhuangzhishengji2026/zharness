/**
 * Built-in extension: pets —— 宠物插件（盲盒抽奖）。
 *
 * GUI 之外的三条入口共用一份宠物档案（store.ts，<agentDir>/pets/pets.json）：
 *
 * 1. `pet` agent 工具 —— LLM 可在会话中开盲盒 / 查看图鉴 / 喂食玩耍，
 *    例如「帮我抽个宠物」「我的宠物怎么样了」。
 * 2. `/pets` 斜杠命令 —— TUI/RPC 会话里人工互动
 *    （list / hatch / feed / play / carry / rename / release）。
 * 3. GUI 浮动宠物挂件 —— Web 前端经 `pet_state` / `pet_hatch` / `pet_interact` /
 *    `pet_rename` / `pet_carry` / `pet_release` RPC 读写
 *    （协议见 packages/protocol，分发见 packages/rpc/rpc-mode.ts）。
 *
 * 变更后向 EventStore 追加 CUSTOM_MESSAGE(display:false, kind=pets_changed)
 * 事件，GUI 订阅刷新；聊天流不渲染。
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.js";
import {
	emitPetsChanged,
	hatchPet,
	interactPet,
	getActivePetView,
	getPetsState,
	releasePet,
	renamePet,
	setActivePet,
	toPetView,
	type PetView,
} from "./store.js";
import {
	listSpecies,
	RARITY_META,
	SHINY_RATE,
	type PetRarity,
} from "./species.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const PETS_EXTENSION_ID = "pets";

/** 稀有度星标（命令输出用）。 */
function rarityStars(rarity: PetRarity): string {
	const stars: Record<PetRarity, string> = { N: "★", R: "★★", SR: "★★★", SSR: "★★★★" };
	return stars[rarity];
}

function formatPetLine(view: PetView, activeId?: string): string {
	const shiny = view.pet.shiny ? " ✨闪光" : "";
	const carry = view.pet.id === activeId ? " [携带中]" : "";
	return `  ${view.speciesEmoji} ${view.pet.name}（${view.speciesName}）${rarityStars(view.pet.rarity)}${shiny}${carry} — 心情 ${view.pet.mood}/100 · 精力 ${view.pet.energy}/100`;
}

function formatPetList(activeId?: string): string {
	const state = getPetsState();
	if (state.pets.length === 0) {
		return "还没有宠物。用 /pets hatch 开一盒盲盒，或让 agent 帮你抽一只。";
	}
	const lines = [
		`宠物档案（${state.pets.length} 只 · 累计开盒 ${state.totalHatched} 次）`,
		...state.pets.map((p) => {
			const view = toPetView(p);
			return view ? formatPetLine(view, activeId) : null;
		}).filter((l): l is string => l !== null),
	];
	return lines.join("\n");
}

function formatHatchResult(pet: PetView, shiny: boolean, overflow: boolean): string {
	const meta = RARITY_META[pet.pet.rarity];
	const head = overflow
		? `📦 开盒成功！但档案已满（上限 30 只），本次未入册——先放生一只再来抽吧。`
		: `📦 开盒成功！抽到了：`;
	const shinyLine = shiny ? "\n✨✨ 闪光变体！万中无一的缘分（互动加成 +10）" : "";
	return [
		head,
		`  ${pet.speciesEmoji} ${pet.pet.name}（${pet.speciesName}）`,
		`  稀有度：${rarityStars(pet.pet.rarity)} ${meta.label}（出货率 ${meta.weight}%）${shinyLine}`,
		`  个性：${pet.personalityName}`,
		`  「${pet.catchphrase}」`,
		`  图鉴：${pet.blurb}`,
	].join("\n");
}

const USAGE = `Usage:
  /pets list                查看宠物档案
  /pets hatch               开一次盲盒（N/R/SR/SSR 加权 + 闪光变体）
  /pets feed <id>           喂食（每日一次加成）
  /pets play <id>           玩耍（每日一次加成，亲密 +1）
  /pets carry <id>          设为携带中的宠物（GUI 挂件展示）
  /pets rename <id> <名字>  改名
  /pets release <id>        放生
  /pets dex                 查看图鉴与出货率
  /pets help                显示本帮助

GUI 右下角「宠物挂件」与本命令共用同一份数据。`;

export const createPetsExtension: ExtensionFactory = (zharness: ExtensionAPI) => {
	// ------------------------------------------------------------------
	// Agent 工具：让 LLM 在会话内开盲盒 / 照料宠物
	// ------------------------------------------------------------------
	zharness.registerTool({
		name: "pet",
		label: "Pet",
		description:
			"Blind-box pet plugin. Actions: 'state' returns the pet collection and the currently carried pet; " +
			"'hatch' opens one blind box (weighted N/R/SR/SSR rarity + rare shiny variant); " +
			"'feed'/'play' interact with a pet (daily bonus); 'carry' sets the pet shown in the GUI widget; " +
			"'release' removes a pet. Use this when the user asks to open a pet blind box, check or care for pets, " +
			"e.g. 「抽个宠物看看手气」.",
		promptSnippet: "pet: open blind-box pet gacha, view and care for the pet collection",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("state"),
				Type.Literal("hatch"),
				Type.Literal("feed"),
				Type.Literal("play"),
				Type.Literal("carry"),
				Type.Literal("release"),
			]),
			petId: Type.Optional(Type.String({ description: "Pet id (required for feed/play/carry/release)" })),
			name: Type.Optional(Type.String({ description: "New name for rename via /pets command (not used by tool)" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const store = ctx.sessionManager.eventStore;
			switch (params.action) {
				case "state": {
					const state = getPetsState();
					const active = getActivePetView();
					return {
						content: [{ type: "text", text: formatPetList(state.activePetId) }],
						details: { ...state, activePetView: active },
					};
				}
				case "hatch": {
					const { pet, draw, overflow } = hatchPet();
					const view = toPetView(pet);
					const text = view ? formatHatchResult(view, draw.shiny, overflow) : "开盒失败：图鉴数据异常。";
					if (!overflow) {
						emitPetsChanged(store, `开盲盒抽到 ${pet.name}（${pet.rarity}${pet.shiny ? " · 闪光" : ""}）`);
					}
					return {
						content: [{ type: "text", text }],
						details: { pet, draw, overflow },
					};
				}
				case "feed":
				case "play": {
					if (!params.petId) {
						throw new Error(`pet ${params.action}: petId is required（action=state 查看 id）`);
					}
					const result = interactPet(params.petId, params.action);
					if (!result.pet) {
						return { content: [{ type: "text", text: `未找到宠物 ${params.petId}（action=state 查看 id）。` }] };
					}
					const view = toPetView(result.pet);
					if (!result.effected) {
						return {
							content: [{ type: "text", text: `${view?.speciesEmoji ?? ""} ${result.pet.name} 今天已经${params.action === "feed" ? "吃饱了" : "玩够啦"}，明天再来吧（每日各一次加成）。` }],
							details: result,
						};
					}
					emitPetsChanged(store, `${params.action === "feed" ? "喂食" : "陪玩"}：${result.pet.name}`);
					return {
						content: [{ type: "text", text: `${view?.speciesEmoji ?? ""} ${result.pet.name} 心情 +${result.moodDelta}，精力 ${result.energyDelta >= 0 ? "+" : ""}${result.energyDelta}。（心情 ${result.pet.mood}/100 · 精力 ${result.pet.energy}/100）` }],
						details: result,
					};
				}
				case "carry": {
					if (!params.petId) {
						throw new Error("pet carry: petId is required");
					}
					const pet = setActivePet(params.petId);
					if (!pet) {
						return { content: [{ type: "text", text: `未找到宠物 ${params.petId}（action=state 查看 id）。` }] };
					}
					emitPetsChanged(store, `携带宠物切换为 ${pet.name}`);
					return {
						content: [{ type: "text", text: `已把 ${pet.name} 设为携带中的宠物，GUI 挂件会跟着换。` }],
						details: { pet },
					};
				}
				case "release": {
					if (!params.petId) {
						throw new Error("pet release: petId is required");
					}
					const released = releasePet(params.petId);
					if (released) {
						emitPetsChanged(store, "放生了一只宠物");
					}
					return {
						content: [{ type: "text", text: released ? "已放生。念在缘分，江湖再见。" : `未找到宠物 ${params.petId}。` }],
						details: { released },
					};
				}
			}
		},
	});

	// ------------------------------------------------------------------
	// 斜杠命令：人工互动
	// ------------------------------------------------------------------
	zharness.registerCommand("pets", {
		description: "宠物插件：盲盒抽宠物、喂食玩耍、切换携带（与 GUI 宠物挂件同一份数据）。",
		getArgumentCompletions: (argumentPrefix) => {
			const subs = ["list", "hatch", "feed", "play", "carry", "rename", "release", "dex", "help"];
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
					notify(formatPetList(getPetsState().activePetId));
					return;
				}
				case "hatch": {
					const { pet, draw, overflow } = hatchPet();
					const view = toPetView(pet);
					if (view) notify(formatHatchResult(view, draw.shiny, overflow));
					if (!overflow) {
						emitPetsChanged(store, `开盲盒抽到 ${pet.name}（${pet.rarity}${pet.shiny ? " · 闪光" : ""}）`);
					}
					return;
				}
				case "feed":
				case "play": {
					if (!rest) {
						notify(`缺少宠物 id。用法：/pets ${subcommand} <id>（/pets list 查看）`, "warning");
						return;
					}
					const result = interactPet(rest, subcommand);
					if (!result.pet) {
						notify(`未找到宠物 ${rest}（/pets list 查看 id）`, "warning");
						return;
					}
					if (!result.effected) {
						notify(`${result.pet.name} 今天已经${subcommand === "feed" ? "吃饱了" : "玩够啦"}，明天再来吧。`, "info");
						return;
					}
					emitPetsChanged(store, `${subcommand === "feed" ? "喂食" : "陪玩"}：${result.pet.name}`);
					notify(`${result.pet.name} 心情 +${result.moodDelta}，精力 ${result.energyDelta >= 0 ? "+" : ""}${result.energyDelta}。`, "info");
					return;
				}
				case "carry": {
					if (!rest) {
						notify("缺少宠物 id。用法：/pets carry <id>", "warning");
						return;
					}
					const pet = setActivePet(rest);
					if (!pet) {
						notify(`未找到宠物 ${rest}（/pets list 查看 id）`, "warning");
						return;
					}
					emitPetsChanged(store, `携带宠物切换为 ${pet.name}`);
					notify(`已把 ${pet.name} 设为携带中的宠物。`, "info");
					return;
				}
				case "rename": {
					const [petId, ...nameParts] = rest.split(/\s+/);
					const name = nameParts.join(" ").trim();
					if (!petId || !name) {
						notify("用法：/pets rename <id> <名字>", "warning");
						return;
					}
					const pet = renamePet(petId, name);
					if (!pet) {
						notify(`未找到宠物 ${petId} 或名字为空。`, "warning");
						return;
					}
					emitPetsChanged(store, `宠物改名：${pet.name}`);
					notify(`已改名为 ${pet.name}。`, "info");
					return;
				}
				case "release": {
					if (!rest) {
						notify("缺少宠物 id。用法：/pets release <id>", "warning");
						return;
					}
					const released = releasePet(rest);
					if (released) emitPetsChanged(store, "放生了一只宠物");
					notify(released ? "已放生。念在缘分，江湖再见。" : `未找到宠物 ${rest}。`, released ? "info" : "warning");
					return;
				}
				case "dex": {
					const lines = [
						`图鉴（出货率：N ${RARITY_META.N.weight}% / R ${RARITY_META.R.weight}% / SR ${RARITY_META.SR.weight}% / SSR ${RARITY_META.SSR.weight}% · 闪光 ${Math.round(SHINY_RATE * 1000) / 10}%）`,
						...listSpecies().map((s) => {
							const meta = RARITY_META[s.rarity];
							return `  ${s.emoji} ${s.name}（${s.id}）${rarityStars(s.rarity)} [${meta.label}] — ${s.blurb}`;
						}),
					];
					notify(lines.join("\n"));
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
