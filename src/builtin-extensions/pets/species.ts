/**
 * Pet species —— 宠物图鉴与盲盒抽取。
 *
 * 图鉴设计：
 * - 4 档稀有度：N（常见）/ R（稀有）/ SR（史诗）/ SSR（传说），
 *   盲盒按 60/25/12/3 的权重加权抽取。
 * - 每档稀有度有独立的基础外观池（emoji 形态 + 主题色），同档内均匀抽取。
 * - 每只宠物有 ~4% 概率获得「闪光（shiny）」变体：金色描边 + 属性加成，
 *   出货时在开箱结果里重点展示。
 * - 抽到的宠物由「种族 + 个性」组成，个性影响口头禅，纯风味不干预行为。
 *
 * 抽取是纯函数（给定随机源输出结果），方便测试固定种子复现。
 */

export type PetRarity = "N" | "R" | "SR" | "SSR";

export interface PetSpecies {
	/** 种族 id（如 "cat-calico"）。 */
	id: string;
	/** 种族名（如 "三花猫"）。 */
	name: string;
	/** 稀有度。 */
	rarity: PetRarity;
	/** 外观形态（emoji，渲染主形象）。 */
	emoji: string;
	/** 主题色（GUI 渲染背景/描边）。 */
	color: string;
	/** 一句种族简介。 */
	blurb: string;
}

export interface PetPersonality {
	id: string;
	/** 个性名（如 "话痨"）。 */
	name: string;
	/** 口头禅模板（{name} 会被替换成宠物名）。 */
	catchphrase: string;
}

// ---------------------------------------------------------------------------
// 图鉴
// ---------------------------------------------------------------------------

const SPECIES: PetSpecies[] = [
	// ---- N：常见（蓝色系） ----
	{ id: "cat-calico", name: "三花猫", rarity: "N", emoji: "🐱", color: "#5aa2e8", blurb: "会踩键盘的键盘侠天敌。" },
	{ id: "dog-shiba", name: "柴犬", rarity: "N", emoji: "🐶", color: "#e8a05a", blurb: "尾巴摇动的频率等于构建通过的概率。" },
	{ id: "hamster", name: "仓鼠", rarity: "N", emoji: "🐹", color: "#d8b25a", blurb: "腮帮子里塞满了未提交的改动。" },
	{ id: "chick", name: "小鸡", rarity: "N", emoji: "🐤", color: "#e8d05a", blurb: "唧唧喳喳，像极了对齐会议。" },
	{ id: "rabbit", name: "小白兔", rarity: "N", emoji: "🐰", color: "#c8c8d0", blurb: "胡萝卜与热更新都吃得很快。" },

	// ---- R：稀有（绿色系） ----
	{ id: "fox", name: "小狐狸", rarity: "R", emoji: "🦊", color: "#e87a3a", blurb: "声称 bug 是猎人的陷阱。" },
	{ id: "panda", name: "熊猫", rarity: "R", emoji: "🐼", color: "#8a9a5a", blurb: "黑白配色的极简主义大师。" },
	{ id: "penguin", name: "企鹅", rarity: "R", emoji: "🐧", color: "#5a8ae0", blurb: "在冷水机旁找到了归宿。" },
	{ id: "koala", name: "考拉", rarity: "R", emoji: "🐨", color: "#9ab8a0", blurb: "每天睡 22 小时，剩下 2 小时在 code review。" },
	{ id: "frog", name: "树蛙", rarity: "R", emoji: "🐸", color: "#5ab86a", blurb: "对「先把测试写了」有独到见解。" },

	// ---- SR：史诗（紫色系） ----
	{ id: "unicorn", name: "独角兽", rarity: "SR", emoji: "🦄", color: "#b07ae8", blurb: "角尖能编译任何语言。" },
	{ id: "dragon", name: "小龙", rarity: "SR", emoji: "🐲", color: "#7a5ae0", blurb: "喷的是火，吐的是日志。" },
	{ id: "phoenix", name: "凤凰", rarity: "SR", emoji: "🔥", color: "#e8605a", blurb: "炸机之后涅槃，生产事故的克星。" },
	{ id: "owl", name: "夜枭", rarity: "SR", emoji: "🦉", color: "#9a7ae0", blurb: "只在凌晨两点提供建议。" },

	// ---- SSR：传说（金色系） ----
	{ id: "axolotl", name: "六角恐龙", rarity: "SSR", emoji: "🦎", color: "#ffb0d8", blurb: "传说中永不退货的吉祥物。" },
	{ id: "whale", name: "程序员鲸", rarity: "SSR", emoji: "🐳", color: "#5ac8e8", blurb: "吞下整个容器编排还能面不改色。" },
	{ id: "cat-duke", name: "公爵猫", rarity: "SSR", emoji: "😺", color: "#e8c85a", blurb: "戴上礼帽后，code review 从不手软。" },
	{ id: "corgi-king", name: "柯基王", rarity: "SSR", emoji: "🐕", color: "#ffb05a", blurb: "小短腿跑赢了所有 CI 流水线。" },
];

const PERSONALITIES: PetPersonality[] = [
	{ id: "chatterbox", name: "话痨", catchphrase: "{name}：今天也要元气满满地写代码哦！" },
	{ id: "zen", name: "禅系", catchphrase: "{name}：……（它安静地看着你，仿佛在说编译错误只是幻觉）" },
	{ id: "tsundere", name: "傲娇", catchphrase: "{name}：才、才不是特意陪你的，只是顺路！" },
	{ id: "scholar", name: "学究", catchphrase: "{name}：根据《人月神话》第 3 章，这个需求估计要……" },
	{ id: "foodie", name: "干饭魂", catchphrase: "{name}：这行代码闻起来像小鱼干的味道。" },
	{ id: "night-owl", name: "夜猫子", catchphrase: "{name}：凌晨三点的月光，是给赶 due 的人的。" },
	{ id: "cheerful", name: "元气", catchphrase: "{name}：测试全绿！今天也是满分的一天！" },
	{ id: "grumpy", name: "臭脸", catchphrase: "{name}：哼，谁又把 main 分支搞红了。" },
];

/** 全部种族（只读副本）。 */
export function listSpecies(): PetSpecies[] {
	return SPECIES.map((s) => ({ ...s }));
}

/** 全部个性（只读副本）。 */
export function listPersonalities(): PetPersonality[] {
	return PERSONALITIES.map((p) => ({ ...p }));
}

export function getSpecies(id: string): PetSpecies | undefined {
	const hit = SPECIES.find((s) => s.id === id);
	return hit ? { ...hit } : undefined;
}

export function getPersonality(id: string): PetPersonality | undefined {
	const hit = PERSONALITIES.find((p) => p.id === id);
	return hit ? { ...hit } : undefined;
}

// ---------------------------------------------------------------------------
// 稀有度与盲盒
// ---------------------------------------------------------------------------

/** 稀有度展示名与权重。 */
export const RARITY_META: Record<PetRarity, { label: string; weight: number; color: string }> = {
	N: { label: "普通", weight: 60, color: "#8a8f99" },
	R: { label: "稀有", weight: 25, color: "#22a05c" },
	SR: { label: "史诗", weight: 12, color: "#9a5ce0" },
	SSR: { label: "传说", weight: 3, color: "#e8a013" },
};

/** 闪光变体概率（4%）。 */
export const SHINY_RATE = 0.04;

/** 闪光加成：心情/精力回复翻倍（风味数值，仅供 GUI 展示）。 */
export const SHINY_MOOD_BONUS = 10;

/** 盲盒抽奖结果。 */
export interface BlindBoxResult {
	species: PetSpecies;
	personality: PetPersonality;
	/** 是否闪光变体。 */
	shiny: boolean;
}

/** 简单随机源接口（测试可注入固定序列）。 */
export type RandomSource = () => number;

function pickWeightedRarity(random: RandomSource): PetRarity {
	const total = Object.values(RARITY_META).reduce((sum, m) => sum + m.weight, 0);
	let roll = random() * total;
	for (const rarity of Object.keys(RARITY_META) as PetRarity[]) {
		roll -= RARITY_META[rarity].weight;
		if (roll < 0) return rarity;
	}
	return "N";
}

/**
 * 抽一次盲盒：稀有度加权 → 同档种族均匀 → 个性均匀 → 闪光判定。
 * 传入自定义 random 以便测试复现。
 */
export function rollBlindBox(random: RandomSource = Math.random): BlindBoxResult {
	const rarity = pickWeightedRarity(random);
	const pool = SPECIES.filter((s) => s.rarity === rarity);
	// 防御：池子非空（图鉴常量保证），fallback N 档。
	const species = pool.length > 0
		? pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
		: SPECIES[0];
	const personality = PERSONALITIES[Math.min(PERSONALITIES.length - 1, Math.floor(random() * PERSONALITIES.length))];
	const shiny = random() < SHINY_RATE;
	return { species, personality, shiny };
}

/** 渲染口头禅（{name} → 宠物名）。 */
export function renderCatchphrase(personality: PetPersonality, petName: string): string {
	return personality.catchphrase.replaceAll("{name}", petName);
}
