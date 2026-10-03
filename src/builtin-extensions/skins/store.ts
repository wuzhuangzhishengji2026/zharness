/**
 * Skins store —— 换肤插件数据层。
 *
 * 皮肤分两类，统一由本模块管理，GUI（设置页皮肤库）/ `/skins` 命令 /
 * `skin` agent 工具读的是同一份数据：
 *
 * 1. 内置色板皮肤 —— 一组预调好的 CSS 变量覆盖（浅色/深色各一套），
 *    无磁盘资产，随代码分发。
 * 2. 自定义图片皮肤 —— 用户上传的图片落盘到 `<agentDir>/skins/images/`，
 *    元数据（名称、遮罩浓度、模糊度）存 `<agentDir>/skins/skins.json`。
 *    应用时作为全屏背景层渲染，叠加可调遮罩保证文字可读。
 *
 * 当前启用的皮肤 id（全局，应用级偏好，不随工作区切换）同样持久化在
 * skins.json —— GUI 启动时先用 localStorage 缓存即时上妆，再经 RPC 对账。
 *
 * 写入采用「临时文件 + rename」原子写，损坏文件按默认态处理，不阻塞会话。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";

/** 可被皮肤覆盖的 CSS 变量名（与 apps/web/src/index.css 的主题色板一致）。 */
export type SkinColorVar =
	| "--bg"
	| "--surface"
	| "--surface-2"
	| "--surface-3"
	| "--border"
	| "--fg"
	| "--muted"
	| "--accent"
	| "--accent-fg"
	| "--welcome-glow";

/** 一个模式（light/dark）下的 CSS 变量覆盖表。 */
export type SkinPalette = Partial<Record<SkinColorVar, string>>;

export interface SkinColors {
	light: SkinPalette;
	dark: SkinPalette;
}

export interface SkinImageMeta {
	/** 图片文件名（位于 <agentDir>/skins/images/ 下）。 */
	fileName: string;
	/** 图片 MIME 类型。 */
	mime: string;
	/** 遮罩浓度 0-0.9（数值越大背景越暗/越浅，文字越清晰）。 */
	dim: number;
	/** 背景模糊半径 px（0-12）。 */
	blur: number;
}

export interface Skin {
	id: string;
	name: string;
	kind: "builtin" | "custom";
	description?: string;
	/** 色板覆盖（内置色板皮肤）。 */
	colors?: SkinColors;
	/** 背景图元数据（自定义图片皮肤）。 */
	image?: SkinImageMeta;
}

interface SkinsFile {
	version: 1;
	/** 自定义皮肤元数据。 */
	custom: Skin[];
	/** 当前启用的皮肤 id（"default" = 跟随系统明暗的默认皮肤）。 */
	activeSkinId: string;
}

// ---------------------------------------------------------------------------
// 内置皮肤目录
// ---------------------------------------------------------------------------

/** 默认皮肤：不覆盖任何变量，走 index.css 的原始浅色/深色色板。 */
const BUILTIN_SKINS: Skin[] = [
	{
		id: "default",
		name: "默认",
		kind: "builtin",
		description: "ZHarness 原生浅色 / 深色",
	},
	{
		id: "sakura",
		name: "樱花粉",
		kind: "builtin",
		description: "柔和粉色点缀，少女心满满",
		colors: {
			light: {
				"--bg": "#fdf5f7",
				"--surface": "#ffffff",
				"--surface-2": "#faeef2",
				"--surface-3": "#ffe4ec",
				"--border": "#f2d4de",
				"--fg": "#432b33",
				"--muted": "#a07c88",
				"--accent": "#e5558d",
				"--accent-fg": "#ffffff",
				"--welcome-glow": "rgba(229, 85, 141, 0.1)",
			},
			dark: {
				"--bg": "#120c0e",
				"--surface": "#1f1518",
				"--surface-2": "#170f12",
				"--surface-3": "#2e1e24",
				"--border": "#3d2830",
				"--fg": "#f3e3e8",
				"--muted": "#b59aa4",
				"--accent": "#ff7ab0",
				"--accent-fg": "#33121f",
				"--welcome-glow": "rgba(229, 85, 141, 0.12)",
			},
		},
	},
	{
		id: "forest",
		name: "森林绿",
		kind: "builtin",
		description: "深林翠色，安静专注",
		colors: {
			light: {
				"--bg": "#f3f8f2",
				"--surface": "#ffffff",
				"--surface-2": "#e9f2e7",
				"--surface-3": "#dcecd8",
				"--border": "#cfe3cb",
				"--fg": "#24352a",
				"--muted": "#6f8a78",
				"--accent": "#1e9e5a",
				"--accent-fg": "#ffffff",
				"--welcome-glow": "rgba(30, 158, 90, 0.1)",
			},
			dark: {
				"--bg": "#0b100c",
				"--surface": "#141c16",
				"--surface-2": "#0e130f",
				"--surface-3": "#1e2b21",
				"--border": "#27392c",
				"--fg": "#e2efe5",
				"--muted": "#8faa96",
				"--accent": "#34d17c",
				"--accent-fg": "#082512",
				"--welcome-glow": "rgba(52, 209, 124, 0.1)",
			},
		},
	},
	{
		id: "sunset",
		name: "落日橙",
		kind: "builtin",
		description: "暖橙暮色，加班也有温度",
		colors: {
			light: {
				"--bg": "#fdf8f2",
				"--surface": "#ffffff",
				"--surface-2": "#f9efe3",
				"--surface-3": "#f5e2cd",
				"--border": "#ecd7bd",
				"--fg": "#3d2f22",
				"--muted": "#a08668",
				"--accent": "#e07b2a",
				"--accent-fg": "#ffffff",
				"--welcome-glow": "rgba(224, 123, 42, 0.1)",
			},
			dark: {
				"--bg": "#120e09",
				"--surface": "#1e1710",
				"--surface-2": "#171209",
				"--surface-3": "#2d2216",
				"--border": "#3b2d1d",
				"--fg": "#f2e8da",
				"--muted": "#b09a7d",
				"--accent": "#ff9c4d",
				"--accent-fg": "#2d1503",
				"--welcome-glow": "rgba(255, 156, 77, 0.1)",
			},
		},
	},
	{
		id: "aurora",
		name: "极光紫",
		kind: "builtin",
		description: "夜空极光，梦幻紫调",
		colors: {
			light: {
				"--bg": "#f6f4fc",
				"--surface": "#ffffff",
				"--surface-2": "#efecf9",
				"--surface-3": "#e4dff5",
				"--border": "#d8d1ef",
				"--fg": "#2f2a44",
				"--muted": "#827ba0",
				"--accent": "#7c5cf0",
				"--accent-fg": "#ffffff",
				"--welcome-glow": "rgba(124, 92, 240, 0.1)",
			},
			dark: {
				"--bg": "#0d0b14",
				"--surface": "#171425",
				"--surface-2": "#110e1b",
				"--surface-3": "#241f3a",
				"--border": "#322b4e",
				"--fg": "#e9e5f6",
				"--muted": "#9c94bd",
				"--accent": "#a48cff",
				"--accent-fg": "#1b1136",
				"--welcome-glow": "rgba(164, 140, 255, 0.12)",
			},
		},
	},
	{
		id: "deepsea",
		name: "墨海蓝",
		kind: "builtin",
		description: "深海墨蓝，代码人的浪漫",
		colors: {
			light: {
				"--bg": "#f1f6fb",
				"--surface": "#ffffff",
				"--surface-2": "#e6eff8",
				"--surface-3": "#d7e7f5",
				"--border": "#c4d9ec",
				"--fg": "#1f3040",
				"--muted": "#6a83a0",
				"--accent": "#1379d6",
				"--accent-fg": "#ffffff",
				"--welcome-glow": "rgba(19, 121, 214, 0.1)",
			},
			dark: {
				"--bg": "#080d14",
				"--surface": "#101a26",
				"--surface-2": "#0a121b",
				"--surface-3": "#182636",
				"--border": "#213448",
				"--fg": "#dfe9f4",
				"--muted": "#89a2ba",
				"--accent": "#4db2ff",
				"--accent-fg": "#04182d",
				"--welcome-glow": "rgba(77, 178, 255, 0.12)",
			},
		},
	},
];

/** 内置皮肤只读目录（含 default）。 */
export function listBuiltinSkins(): Skin[] {
	return BUILTIN_SKINS.map((s) => ({ ...s, colors: s.colors && structuredClone(s.colors) }));
}

export function getBuiltinSkin(id: string): Skin | undefined {
	const hit = BUILTIN_SKINS.find((s) => s.id === id);
	return hit ? { ...hit, colors: hit.colors && structuredClone(hit.colors) } : undefined;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function getSkinsDir(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "skins");
}

function getSkinsFilePath(agentDir?: string): string {
	return join(getSkinsDir(agentDir), "skins.json");
}

function readSkinsFile(agentDir?: string): SkinsFile {
	const path = getSkinsFilePath(agentDir);
	if (!existsSync(path)) return { version: 1, custom: [], activeSkinId: "default" };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SkinsFile>;
		return {
			version: 1,
			custom: Array.isArray(parsed.custom)
				? parsed.custom.filter(
						(s): s is Skin =>
							typeof s === "object" &&
							s !== null &&
							typeof s.id === "string" &&
							typeof s.name === "string",
					)
				: [],
			activeSkinId: typeof parsed.activeSkinId === "string" ? parsed.activeSkinId : "default",
		};
	} catch {
		// 损坏文件按默认态处理，下次写入时覆盖。
		return { version: 1, custom: [], activeSkinId: "default" };
	}
}

function writeSkinsFile(file: SkinsFile, agentDir?: string): void {
	const path = getSkinsFilePath(agentDir);
	mkdirSync(getSkinsDir(agentDir), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2));
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// 皮肤目录 / 状态
// ---------------------------------------------------------------------------

export interface SkinState {
	/** 全部皮肤（内置在前，自定义在后）。 */
	skins: Skin[];
	activeSkinId: string;
}

/** 内置 + 自定义皮肤与当前启用状态。 */
export function getSkinState(agentDir?: string): SkinState {
	const file = readSkinsFile(agentDir);
	return {
		skins: [...listBuiltinSkins(), ...file.custom.map((s) => ({ ...s }))],
		activeSkinId: file.activeSkinId,
	};
}

/** 按 id 查皮肤（内置 + 自定义）。 */
export function findSkin(id: string, agentDir?: string): Skin | undefined {
	if (id === "default") return getBuiltinSkin("default");
	return getSkinState(agentDir).skins.find((s) => s.id === id);
}

/**
 * 启用一个皮肤。id 不存在时返回 null（保持原状）。
 * 自定义图片皮肤可顺带更新遮罩/模糊参数（一起落盘）。
 */
export function applySkin(
	id: string,
	options?: { dim?: number; blur?: number },
	agentDir?: string,
): Skin | null {
	const file = readSkinsFile(agentDir);
	const skin = id === "default" ? getBuiltinSkin("default") : file.custom.find((s) => s.id === id) ?? getBuiltinSkin(id);
	if (!skin) return null;
	if (skin.kind === "custom" && skin.image && options) {
		if (typeof options.dim === "number") skin.image.dim = clamp(options.dim, 0, 0.9);
		if (typeof options.blur === "number") skin.image.blur = clamp(options.blur, 0, 12);
		// 回写更新后的自定义皮肤元数据。
		const idx = file.custom.findIndex((s) => s.id === skin.id);
		if (idx >= 0) file.custom[idx] = { ...skin };
	}
	file.activeSkinId = id;
	writeSkinsFile(file, agentDir);
	return skin;
}

// ---------------------------------------------------------------------------
// 自定义图片皮肤
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function extForMime(mime: string): string {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "jpg";
	}
}

/** 解析 data URL：{ mime, bytes }。非图片类型或超限返回 null。 */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
	const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
	if (!match) return null;
	const mime = match[1].toLowerCase();
	if (!ALLOWED_MIME.has(mime)) return null;
	let bytes: Buffer;
	try {
		bytes = Buffer.from(match[2], "base64");
	} catch {
		return null;
	}
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
	return { mime, bytes };
}

export interface AddSkinInput {
	name: string;
	/** data URL（data:image/png;base64,...）。 */
	dataUrl: string;
	dim?: number;
	blur?: number;
}

/**
 * 新增自定义图片皮肤并启用。图片写入 `<agentDir>/skins/images/`，元数据入
 * skins.json。名称缺省取序号，非法/超限图片抛错由调用方提示。
 */
export function addCustomSkin(input: AddSkinInput, agentDir?: string): Skin {
	const parsed = parseDataUrl(input.dataUrl);
	if (!parsed) {
		throw new Error("自定义皮肤图片无效（仅支持 PNG/JPG/WebP/GIF，且不超过 8MB）");
	}
	const file = readSkinsFile(agentDir);
	const name = input.name.trim() || `自定义皮肤 ${file.custom.length + 1}`;
	const id = `custom-${randomUUID().slice(0, 8)}`;
	const fileName = `${id}.${extForMime(parsed.mime)}`;
	const dir = getSkinsDir(agentDir);
	mkdirSync(join(dir, "images"), { recursive: true });
	writeFileSync(join(dir, "images", fileName), parsed.bytes);
	const skin: Skin = {
		id,
		name,
		kind: "custom",
		description: "自定义图片皮肤",
		image: {
			fileName,
			mime: parsed.mime,
			dim: clamp(input.dim ?? 0.45, 0, 0.9),
			blur: clamp(input.blur ?? 0, 0, 12),
		},
	};
	file.custom.push(skin);
	file.activeSkinId = id;
	writeSkinsFile(file, agentDir);
	return skin;
}

/** 删除自定义皮肤（连同图片文件）。删除启用中的皮肤时回退 default。内置皮肤不可删。 */
export function removeCustomSkin(id: string, agentDir?: string): boolean {
	const file = readSkinsFile(agentDir);
	const idx = file.custom.findIndex((s) => s.id === id);
	if (idx === -1) return false;
	const [removed] = file.custom.splice(idx, 1);
	try {
		rmSync(join(getSkinsDir(agentDir), "images", removed.image?.fileName ?? ""), { force: true });
	} catch {
		// 图片文件删除失败不阻塞元数据删除。
	}
	if (file.activeSkinId === id) file.activeSkinId = "default";
	writeSkinsFile(file, agentDir);
	return true;
}

/** 读取皮肤背景图的 data URL（GUI 渲染用）。无图或文件缺失返回 null。 */
export function readSkinImage(id: string, agentDir?: string): string | null {
	const skin = findSkin(id, agentDir);
	if (!skin?.image) return null;
	const path = join(getSkinsDir(agentDir), "images", skin.image.fileName);
	if (!existsSync(path)) return null;
	try {
		return `data:${skin.image.mime};base64,${readFileSync(path).toString("base64")}`;
	} catch {
		return null;
	}
}

/** 重命名自定义皮肤。 */
export function renameCustomSkin(id: string, name: string, agentDir?: string): Skin | null {
	const next = name.trim();
	if (!next) return null;
	const file = readSkinsFile(agentDir);
	const skin = file.custom.find((s) => s.id === id);
	if (!skin) return null;
	skin.name = next;
	writeSkinsFile(file, agentDir);
	return skin;
}

// ---------------------------------------------------------------------------
// 协议视图（packages/protocol 的 RpcSkin 形状，剔除本地文件名细节）
// ---------------------------------------------------------------------------

/** Skin → 协议 RpcSkin 视图（不含 fileName，图片本体走 readSkinImage）。 */
export function toRpcSkin(skin: Skin): {
	id: string;
	name: string;
	kind: Skin["kind"];
	description?: string;
	colors?: SkinColors;
	image?: { mime: string; dim: number; blur: number };
} {
	return {
		id: skin.id,
		name: skin.name,
		kind: skin.kind,
		...(skin.description ? { description: skin.description } : {}),
		...(skin.colors ? { colors: structuredClone(skin.colors) } : {}),
		...(skin.image
			? { image: { mime: skin.image.mime, dim: skin.image.dim, blur: skin.image.blur } }
			: {}),
	};
}
