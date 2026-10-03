/**
 * Pets store —— 宠物插件数据层。
 *
 * 全局一份宠物档案（<agentDir>/pets/pets.json，应用级偏好，不随工作区切换），
 * GUI 浮动挂件 / `pet` agent 工具 / `/pets` 命令共用。
 *
 * 模型：
 * - 盲盒抽奖（roll）生成宠物：稀有度加权 + 闪光变体（species.ts）。
 * - 简单养成：喂食/玩耍回复心情与精力，有每日冷却；N→SSR 稀有度越高
 *   开箱越稀有，纯数值风味，不影响 agent 行为。
 * - 携带（active）：多只宠物中指定一只跟随 GUI 挂件展示。
 * - 放生（release）：从档案移除（念在缘分，不做黑名单）。
 *
 * 写入沿用任务看板/换肤插件的「临时文件 + rename」原子写模式，损坏文件
 * 按空档案处理，不阻塞会话。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import type { EventAppendInput } from "../../core/event-store/store.js";
import {
	getPersonality,
	getSpecies,
	rollBlindBox,
	type BlindBoxResult,
	type PetRarity,
} from "./species.js";

export interface Pet {
	id: string;
	/** 用户可改的名字（默认种族名 + 编号）。 */
	name: string;
	/** 种族 id（species.ts 图鉴）。 */
	speciesId: string;
	/** 个性 id。 */
	personalityId: string;
	rarity: PetRarity;
	/** 闪光变体。 */
	shiny: boolean;
	/** 心情 0-100。 */
	mood: number;
	/** 精力 0-100。 */
	energy: number;
	/** 亲密度（互动次数累计，无上限）。 */
	bond: number;
	/** 抽到时间（ISO）。 */
	hatchedAt: string;
	/** 最后一次互动时间（ISO，喂食/玩耍每日冷却用）。 */
	lastFedAt?: string;
	lastPlayedAt?: string;
}

interface PetsFile {
	version: 1;
	pets: Pet[];
	/** 当前携带（展示）的宠物 id。 */
	activePetId?: string;
	/** 历史累计开箱次数。 */
	totalHatched: number;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function getPetsDir(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "pets");
}

function getPetsFilePath(agentDir?: string): string {
	return join(getPetsDir(agentDir), "pets.json");
}

function readPetsFile(agentDir?: string): PetsFile {
	const path = getPetsFilePath(agentDir);
	// 注意：空档案必须每次新建字面量 —— 共享常量里的 pets 数组会被浅拷贝
	// 泄漏给调用方（hatchPet 直接 push），跨工作区/跨测试互相污染。
	if (!existsSync(path)) return { version: 1, pets: [], totalHatched: 0 };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PetsFile>;
		const pets = Array.isArray(parsed.pets)
			? parsed.pets.filter(
					(p): p is Pet =>
						typeof p === "object" &&
						p !== null &&
						typeof p.id === "string" &&
						typeof p.speciesId === "string" &&
						typeof p.rarity === "string",
				)
			: [];
		return {
			version: 1,
			pets,
			activePetId: typeof parsed.activePetId === "string" ? parsed.activePetId : undefined,
			totalHatched: typeof parsed.totalHatched === "number" ? parsed.totalHatched : 0,
		};
	} catch {
		return { version: 1, pets: [], totalHatched: 0 };
	}
}

function writePetsFile(file: PetsFile, agentDir?: string): void {
	const path = getPetsFilePath(agentDir);
	mkdirSync(getPetsDir(agentDir), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2));
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// 变更广播
// ---------------------------------------------------------------------------

/** 事件接收面：EventStore 与 facade.runtime.store 都满足该形状。 */
interface AppendOnlyStore {
	append(event: EventAppendInput): unknown;
}

/** 追加一条宠物变更事件（display:false，GUI 订阅刷新，聊天流不渲染）。 */
export function emitPetsChanged(store: AppendOnlyStore | undefined, summary: string): void {
	if (!store) return;
	try {
		store.append({
			actor_id: "pets",
			type: "CUSTOM_MESSAGE",
			payload: {
				extension_id: "pets",
				kind: "pets_changed",
				data: summary,
				display: false,
			},
		});
	} catch {
		// 事件库不可用时静默降级 —— 档案已落盘，事件只是刷新提示。
	}
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export interface PetsState {
	pets: Pet[];
	activePetId?: string;
	totalHatched: number;
}

export function getPetsState(agentDir?: string): PetsState {
	const file = readPetsFile(agentDir);
	return { pets: file.pets.map((p) => ({ ...p })), activePetId: file.activePetId, totalHatched: file.totalHatched };
}

export function findPet(petId: string, agentDir?: string): Pet | undefined {
	return readPetsFile(agentDir).pets.find((p) => p.id === petId);
}

// ---------------------------------------------------------------------------
// 盲盒
// ---------------------------------------------------------------------------

const MAX_PETS = 30;

export interface HatchOutcome {
	pet: Pet;
	/** 抽取原始结果（种族/个性/闪光，供开箱动画展示）。 */
	draw: BlindBoxResult;
	/** 宠物档案已满导致本次开箱未入册。 */
	overflow: boolean;
}

/**
 * 开一次盲盒并落档。档案满（MAX_PETS）时结果标记 overflow，
 * 调用方可决定提示用户放生后再抽（结果不入册）。
 */
export function hatchPet(random: () => number = Math.random, agentDir?: string): HatchOutcome {
	const file = readPetsFile(agentDir);
	const draw = rollBlindBox(random);
	file.totalHatched += 1;
	const pet: Pet = {
		id: `pet_${randomUUID().slice(0, 8)}`,
		name: draw.species.name,
		speciesId: draw.species.id,
		personalityId: draw.personality.id,
		rarity: draw.species.rarity,
		shiny: draw.shiny,
		mood: 60,
		energy: 60,
		bond: 0,
		hatchedAt: new Date().toISOString(),
	};
	const overflow = file.pets.length >= MAX_PETS;
	if (!overflow) {
		file.pets.push(pet);
		// 第一只宠物自动携带。
		if (!file.activePetId) file.activePetId = pet.id;
	}
	writePetsFile(file, agentDir);
	return { pet, draw, overflow };
}

// ---------------------------------------------------------------------------
// 互动
// ---------------------------------------------------------------------------

/** 每日冷却（同一天内喂食/玩耍各只计一次加成，重复互动回复递减为 0）。 */
function isSameDay(iso: string | undefined): boolean {
	if (!iso) return false;
	return iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function clamp100(value: number): number {
	return Math.min(100, Math.max(0, value));
}

export type InteractKind = "feed" | "play";

export interface InteractResult {
	pet: Pet | null;
	/** 心情/精力净变化（提示文案用）。 */
	moodDelta: number;
	energyDelta: number;
	/** false = 已达每日上限或宠物不存在。 */
	effected: boolean;
}

/**
 * 喂食：+30 心情 +20 精力；玩耍：+20 心情 -10 精力（亲密度 +1）。
 * 每日各一次全额加成，同日重复互动不再变化（effected=false）。
 * 闪光宠物加成 +10（SHINY_MOOD_BONUS）。
 */
export function interactPet(
	petId: string,
	kind: InteractKind,
	agentDir?: string,
): InteractResult {
	const file = readPetsFile(agentDir);
	const pet = file.pets.find((p) => p.id === petId);
	if (!pet) return { pet: null, moodDelta: 0, energyDelta: 0, effected: false };
	const stampKey = kind === "feed" ? "lastFedAt" : "lastPlayedAt";
	if (isSameDay(pet[stampKey])) {
		return { pet: { ...pet }, moodDelta: 0, energyDelta: 0, effected: false };
	}
	const bonus = pet.shiny ? 10 : 0;
	const before = { mood: pet.mood, energy: pet.energy };
	if (kind === "feed") {
		pet.mood = clamp100(pet.mood + 30 + bonus);
		pet.energy = clamp100(pet.energy + 20 + bonus);
		pet.lastFedAt = new Date().toISOString();
	} else {
		pet.mood = clamp100(pet.mood + 20 + bonus);
		pet.energy = clamp100(pet.energy - 10);
		pet.bond += 1;
		pet.lastPlayedAt = new Date().toISOString();
	}
	writePetsFile(file, agentDir);
	return {
		pet: { ...pet },
		moodDelta: pet.mood - before.mood,
		energyDelta: pet.energy - before.energy,
		effected: true,
	};
}

/** 改名（空名返回 null）。 */
export function renamePet(petId: string, name: string, agentDir?: string): Pet | null {
	const next = name.trim();
	if (!next) return null;
	const file = readPetsFile(agentDir);
	const pet = file.pets.find((p) => p.id === petId);
	if (!pet) return null;
	pet.name = next.slice(0, 20);
	writePetsFile(file, agentDir);
	return { ...pet };
}

/** 设置携带中的宠物。 */
export function setActivePet(petId: string, agentDir?: string): Pet | null {
	const file = readPetsFile(agentDir);
	const pet = file.pets.find((p) => p.id === petId);
	if (!pet) return null;
	file.activePetId = petId;
	writePetsFile(file, agentDir);
	return { ...pet };
}

/** 放生（档案移除）。返回是否移除；携带中的宠物被放生时自动切换到剩余第一只。 */
export function releasePet(petId: string, agentDir?: string): boolean {
	const file = readPetsFile(agentDir);
	const before = file.pets.length;
	file.pets = file.pets.filter((p) => p.id !== petId);
	if (file.pets.length === before) return false;
	if (file.activePetId === petId) {
		file.activePetId = file.pets[0]?.id;
	}
	writePetsFile(file, agentDir);
	return true;
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 宠物 + 种族 + 个性 + 口头禅的合成视图（GUI / 命令输出共用）。 */
export interface PetView {
	pet: Pet;
	speciesName: string;
	speciesEmoji: string;
	speciesColor: string;
	blurb: string;
	personalityName: string;
	catchphrase: string;
}

export function toPetView(pet: Pet): PetView | null {
	const species = getSpecies(pet.speciesId);
	const personality = getPersonality(pet.personalityId);
	if (!species) return null;
	return {
		pet,
		speciesName: species.name,
		speciesEmoji: species.emoji,
		speciesColor: species.color,
		blurb: species.blurb,
		personalityName: personality?.name ?? "神秘",
		catchphrase: personality ? personality.catchphrase.replaceAll("{name}", pet.name) : "",
	};
}

/** 携带中的宠物视图（无档案或未携带返回 null）。 */
export function getActivePetView(agentDir?: string): PetView | null {
	const file = readPetsFile(agentDir);
	const pet = file.pets.find((p) => p.id === file.activePetId) ?? file.pets[0];
	return pet ? toPetView(pet) : null;
}
