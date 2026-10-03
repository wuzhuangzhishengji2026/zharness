/**
 * 宠物插件（pets 内置扩展）测试
 *
 * 覆盖：
 * 1. 盲盒抽取：固定随机序列的确定性、稀有度权重分布（大数收敛）、闪光判定
 * 2. 图鉴完整性：稀有度池非空、个性口头禅渲染
 * 3. 档案生命周期：开盒入册/自动携带/档案满溢出、喂食玩耍每日冷却、
 *    闪光加成、改名/携带/放生（放生携带中的宠物自动切换）
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hatchPet,
	getActivePetView,
	getPetsState,
	interactPet,
	releasePet,
	renamePet,
	setActivePet,
	toPetView,
} from "../src/builtin-extensions/pets/store.js";
import {
	listPersonalities,
	listSpecies,
	RARITY_META,
	renderCatchphrase,
	rollBlindBox,
	SHINY_RATE,
} from "../src/builtin-extensions/pets/species.js";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "zharness-pets-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

/** 固定序列随机源：依次返回 values，耗尽后循环。 */
function seqRandom(values: number[]): () => number {
	let i = 0;
	return () => values[i++ % values.length]!;
}

describe("图鉴", () => {
	it("每档稀有度种族池非空，SSR 最稀有", () => {
		const species = listSpecies();
		expect(species.length).toBeGreaterThanOrEqual(18);
		for (const rarity of ["N", "R", "SR", "SSR"] as const) {
			expect(species.filter((s) => s.rarity === rarity).length).toBeGreaterThanOrEqual(3);
		}
		expect(RARITY_META.N.weight).toBeGreaterThan(RARITY_META.R.weight);
		expect(RARITY_META.R.weight).toBeGreaterThan(RARITY_META.SR.weight);
		expect(RARITY_META.SR.weight).toBeGreaterThan(RARITY_META.SSR.weight);
	});

	it("口头禅渲染替换宠物名", () => {
		const p = listPersonalities()[0];
		expect(renderCatchphrase(p, "煤球")).not.toContain("{name}");
		expect(renderCatchphrase(p, "煤球")).toContain("煤球");
	});
});

describe("盲盒抽取", () => {
	it("固定随机序列输出确定", () => {
		const a = rollBlindBox(seqRandom([0.1, 0.2, 0.3, 0.9]));
		const b = rollBlindBox(seqRandom([0.1, 0.2, 0.3, 0.9]));
		expect(a.species.id).toBe(b.species.id);
		expect(a.personality.id).toBe(b.personality.id);
		expect(a.shiny).toBe(b.shiny);
		expect(a.shiny).toBe(false); // 第 4 次随机 0.9 ≥ SHINY_RATE
	});

	it("第 4 次随机 < SHINY_RATE 时出闪光", () => {
		const draw = rollBlindBox(seqRandom([0.1, 0.2, 0.3, SHINY_RATE / 2]));
		expect(draw.shiny).toBe(true);
	});

	it("稀有度按权重分布（大数收敛：N > R > SR > SSR）", () => {
		// mulberry32 可复现伪随机。
		let seed = 20260103;
		const random = () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const counts = { N: 0, R: 0, SR: 0, SSR: 0 };
		const runs = 20000;
		for (let i = 0; i < runs; i++) {
			counts[rollBlindBox(random).species.rarity] += 1;
		}
		expect(counts.N).toBeGreaterThan(counts.R);
		expect(counts.R).toBeGreaterThan(counts.SR);
		expect(counts.SR).toBeGreaterThan(counts.SSR);
		// 宽松带宽校验（±40%），防止权重公式改坏。
		expect(counts.N / runs).toBeGreaterThan(0.6 * 0.6);
		expect(counts.N / runs).toBeLessThan(0.6 * 1.4);
		expect(counts.SSR / runs).toBeLessThan(0.05);
		expect(counts.SSR).toBeGreaterThan(0);
	});
});

describe("档案生命周期", () => {
	it("首只宠物自动携带，累计开盒计数", () => {
		const first = hatchPet(undefined, agentDir);
		expect(first.overflow).toBe(false);
		expect(getPetsState(agentDir).activePetId).toBe(first.pet.id);
		expect(getPetsState(agentDir).totalHatched).toBe(1);
		hatchPet(undefined, agentDir);
		expect(getPetsState(agentDir).totalHatched).toBe(2);
		// 第二只不抢占携带位。
		expect(getPetsState(agentDir).activePetId).toBe(first.pet.id);
	});

	it("档案满 30 只后溢出：不入册但仍返回抽取结果", () => {
		let last = hatchPet(undefined, agentDir);
		for (let i = 0; i < 30; i++) {
			last = hatchPet(undefined, agentDir);
		}
		expect(last.overflow).toBe(true);
		expect(last.pet.id).toBeTruthy();
		expect(getPetsState(agentDir).pets).toHaveLength(30);
		expect(getPetsState(agentDir).totalHatched).toBe(31);
	});

	it("喂食每日一次加成，重复互动 effected=false", () => {
		const { pet } = hatchPet(undefined, agentDir);
		const first = interactPet(pet.id, "feed", agentDir);
		expect(first.effected).toBe(true);
		expect(first.moodDelta).toBe(30);
		expect(first.energyDelta).toBe(20);
		const second = interactPet(pet.id, "feed", agentDir);
		expect(second.effected).toBe(false);
		expect(second.pet?.mood).toBe(first.pet?.mood);
	});

	it("闪光宠物喂食加成 +10", () => {
		// 抽取序列：0=N 档、0=池首种族、0=池首个性、0.01=闪光。
		const { pet } = hatchPet(seqRandom([0, 0, 0, 0.01]), agentDir);
		expect(pet.shiny).toBe(true);
		const result = interactPet(pet.id, "feed", agentDir);
		expect(result.moodDelta).toBe(40);
	});

	it("玩耍：心情 +20 / 精力 -10 / 亲密 +1，与喂食各自独立冷却", () => {
		const { pet } = hatchPet(undefined, agentDir);
		const play = interactPet(pet.id, "play", agentDir);
		expect(play.effected).toBe(true);
		expect(play.moodDelta).toBe(20);
		expect(play.energyDelta).toBe(-10);
		expect(play.pet?.bond).toBe(1);
		// 喂食不受玩耍冷却影响。
		expect(interactPet(pet.id, "feed", agentDir).effected).toBe(true);
		expect(interactPet(pet.id, "play", agentDir).effected).toBe(false);
	});

	it("改名 / 携带切换", () => {
		const a = hatchPet(undefined, agentDir).pet;
		const b = hatchPet(undefined, agentDir).pet;
		expect(renamePet(a.id, "  ", agentDir)).toBeNull();
		expect(renamePet(a.id, "煤球", agentDir)?.name).toBe("煤球");
		expect(setActivePet(b.id, agentDir)?.id).toBe(b.id);
		expect(getPetsState(agentDir).activePetId).toBe(b.id);
	});

	it("放生携带中的宠物自动切换到剩余首只；放生不存在返回 false", () => {
		const a = hatchPet(undefined, agentDir).pet;
		const b = hatchPet(undefined, agentDir).pet;
		setActivePet(b.id, agentDir);
		expect(releasePet(b.id, agentDir)).toBe(true);
		expect(getPetsState(agentDir).activePetId).toBe(a.id);
		expect(releasePet(b.id, agentDir)).toBe(false);
	});
});

describe("视图合成", () => {
	it("toPetView 带种族/个性信息；getActivePetView 跟随携带位", () => {
		const { pet } = hatchPet(undefined, agentDir);
		const view = toPetView(pet);
		expect(view).not.toBeNull();
		expect(view?.speciesName).toBeTruthy();
		expect(view?.speciesEmoji).not.toBe("");
		expect(view?.catchphrase).not.toContain("{name}");
		expect(getActivePetView(agentDir)?.pet.id).toBe(pet.id);
	});
});
