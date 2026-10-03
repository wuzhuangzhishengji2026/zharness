/**
 * 换肤插件（skins 内置扩展）测试
 *
 * 覆盖：
 * 1. 内置皮肤目录（default 不覆盖变量，色板皮肤 light/dark 双套）
 * 2. parseDataUrl 校验（非图片 MIME / 超限 / 非 base64）
 * 3. 自定义图片皮肤增删改查（落盘、启用回退、图片读取）
 * 4. applySkin / renameCustomSkin / toRpcSkin
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addCustomSkin,
	applySkin,
	findSkin,
	getSkinState,
	parseDataUrl,
	readSkinImage,
	renameCustomSkin,
	removeCustomSkin,
	toRpcSkin,
} from "../src/builtin-extensions/skins/store.js";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "zharness-skins-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

// 1x1 红色 PNG 的 base64。
const PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("内置皮肤目录", () => {
	it("default 皮肤不携带色板覆盖", () => {
		const def = findSkin("default");
		expect(def).toBeDefined();
		expect(def?.kind).toBe("builtin");
		expect(def?.colors).toBeUndefined();
	});

	it("色板皮肤 light/dark 双套齐全，且包含关键变量", () => {
		const state = getSkinState(agentDir);
		expect(state.activeSkinId).toBe("default");
		const builtins = state.skins.filter((s) => s.kind === "builtin");
		expect(builtins.length).toBeGreaterThanOrEqual(5);
		for (const skin of builtins) {
			if (skin.id === "default") continue;
			expect(skin.colors?.light).toBeDefined();
			expect(skin.colors?.dark).toBeDefined();
			expect(skin.colors?.light["--bg"]).toMatch(/^#/);
			expect(skin.colors?.dark["--fg"]).toMatch(/^#/);
		}
	});
});

describe("parseDataUrl 校验", () => {
	it("接受合法 PNG data URL", () => {
		const parsed = parseDataUrl(PNG_DATA_URL);
		expect(parsed).not.toBeNull();
		expect(parsed?.mime).toBe("image/png");
		expect(parsed?.bytes.length).toBeGreaterThan(0);
	});

	it("拒绝非图片 MIME", () => {
		expect(parseDataUrl("data:text/plain;base64,aGVsbG8=")).toBeNull();
		expect(parseDataUrl("data:image/svg+xml;base64,aGVsbG8=")).toBeNull();
	});

	it("拒绝非 base64 / 空串", () => {
		expect(parseDataUrl("hello")).toBeNull();
		expect(parseDataUrl("data:image/png;base64,")).toBeNull();
	});
});

describe("自定义图片皮肤", () => {
	it("新增即启用，图片落盘且可读回", () => {
		const skin = addCustomSkin({ name: "我的桌面", dataUrl: PNG_DATA_URL, dim: 0.5, blur: 2 }, agentDir);
		expect(skin.kind).toBe("custom");
		expect(skin.image?.dim).toBe(0.5);
		expect(skin.image?.blur).toBe(2);

		const state = getSkinState(agentDir);
		expect(state.activeSkinId).toBe(skin.id);
		expect(state.skins.some((s) => s.id === skin.id)).toBe(true);
		expect(existsSync(join(agentDir, "skins", "images", skin.image!.fileName))).toBe(true);
		expect(readSkinImage(skin.id, agentDir)).toBe(PNG_DATA_URL);
	});

	it("遮罩/模糊参数被夹紧到合法区间", () => {
		const skin = addCustomSkin({ name: "x", dataUrl: PNG_DATA_URL, dim: 5, blur: -3 }, agentDir);
		expect(skin.image?.dim).toBe(0.9);
		expect(skin.image?.blur).toBe(0);
	});

	it("非法图片抛错且不改变状态", () => {
		expect(() => addCustomSkin({ name: "x", dataUrl: "data:text/plain;base64,aGVsbG8=" }, agentDir)).toThrow();
		expect(getSkinState(agentDir).skins.filter((s) => s.kind === "custom")).toHaveLength(0);
	});

	it("applySkin 未知 id 返回 null；已知内置 id 生效", () => {
		expect(applySkin("no-such-skin", undefined, agentDir)).toBeNull();
		const sakura = applySkin("sakura", undefined, agentDir);
		expect(sakura?.id).toBe("sakura");
		expect(getSkinState(agentDir).activeSkinId).toBe("sakura");
	});

	it("删除启用中的自定义皮肤回退 default，并清理图片文件", () => {
		const skin = addCustomSkin({ name: "x", dataUrl: PNG_DATA_URL }, agentDir);
		const fileName = skin.image!.fileName;
		expect(removeCustomSkin(skin.id, agentDir)).toBe(true);
		expect(getSkinState(agentDir).activeSkinId).toBe("default");
		expect(existsSync(join(agentDir, "skins", "images", fileName))).toBe(false);
		expect(removeCustomSkin(skin.id, agentDir)).toBe(false);
		expect(removeCustomSkin("default", agentDir)).toBe(false);
	});

	it("重命名自定义皮肤；内置皮肤重命名无效", () => {
		const skin = addCustomSkin({ name: "旧名", dataUrl: PNG_DATA_URL }, agentDir);
		expect(renameCustomSkin(skin.id, "新名", agentDir)?.name).toBe("新名");
		expect(renameCustomSkin("sakura", "改名", agentDir)).toBeNull();
		expect(renameCustomSkin(skin.id, "  ", agentDir)).toBeNull();
	});
});

describe("toRpcSkin 协议视图", () => {
	it("色板皮肤带 colors，图片皮肤带 image 且不含本地文件名", () => {
		const sakura = findSkin("sakura")!;
		const sakuraView = toRpcSkin(sakura);
		expect(sakuraView.colors?.light["--accent"]).toBe("#e5558d");
		expect(sakuraView.image).toBeUndefined();

		const custom = addCustomSkin({ name: "x", dataUrl: PNG_DATA_URL }, agentDir);
		const view = toRpcSkin(custom);
		expect(view.image).toEqual({ mime: "image/png", dim: 0.45, blur: 0 });
		expect(JSON.stringify(view)).not.toContain("fileName");
	});
});
