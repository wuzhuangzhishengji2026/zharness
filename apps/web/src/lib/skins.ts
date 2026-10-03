/**
 * 换肤插件的数据层与「上妆」引擎（GUI 面）。
 *
 * 数据由内置扩展 `skins` 提供（src/builtin-extensions/skins）：
 * - 皮肤目录与启用状态经 `skin_*` RPC 读写；
 * - 变更经 CUSTOM_MESSAGE(display:false, kind=skin_changed) 广播，收到后重拉；
 * - 应用即渲染：色板皮肤翻译成 CSS 变量覆盖（注入 <style>，light/dark 一并
 *   生效），自定义图片皮肤走 body::before/after 背景图层 + 遮罩。
 *
 * 启动防闪：上次应用的色板皮肤以生成的 CSS 文本缓存在 localStorage
 * （zharness-skin-css / zharness-skin-id），index.html 的内联脚本在 React
 * 挂载前先行注入，避免先白一帧再换肤。
 */

import { sendCommandAwait, subscribeEvents } from "./transport";
import type { RpcSkin, RpcSkinState } from "./types";

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

const EMPTY_STATE: RpcSkinState = { skins: [], activeSkinId: "default" };

/** 拉取皮肤目录与启用状态（失败返回空态，UI 降级为内置色板）。 */
export async function fetchSkinState(): Promise<RpcSkinState> {
	try {
		const r = await sendCommandAwait<RpcSkinState>({ type: "skin_state" }, 10000);
		const data = r.data;
		if (!data || !Array.isArray(data.skins)) return EMPTY_STATE;
		return { skins: data.skins, activeSkinId: typeof data.activeSkinId === "string" ? data.activeSkinId : "default" };
	} catch {
		return EMPTY_STATE;
	}
}

/** 启用皮肤（自定义图片皮肤可顺带调遮罩/模糊）。 */
export async function applySkinRpc(
	skinId: string,
	options?: { dim?: number; blur?: number },
): Promise<RpcSkin | null> {
	const r = await sendCommandAwait<{ skin: RpcSkin | null }>(
		{ type: "skin_apply", skinId, ...(options ?? {}) },
		10000,
	);
	return r.data?.skin ?? null;
}

/** 新增自定义图片皮肤（dataUrl = data:image/...;base64,...）并启用。 */
export async function addSkinRpc(
	name: string,
	dataUrl: string,
	options?: { dim?: number; blur?: number },
): Promise<RpcSkin> {
	const r = await sendCommandAwait<{ skin: RpcSkin }>(
		{ type: "skin_add", name, dataUrl, ...(options ?? {}) },
		20000,
	);
	if (!r.data?.skin) throw new Error("自定义皮肤保存失败");
	return r.data.skin;
}

export async function removeSkinRpc(skinId: string): Promise<boolean> {
	const r = await sendCommandAwait<{ removed: boolean }>({ type: "skin_remove", skinId }, 10000);
	return r.data?.removed ?? false;
}

/** 拉取皮肤背景图 data URL。 */
export async function fetchSkinImage(skinId: string): Promise<string | null> {
	try {
		const r = await sendCommandAwait<{ dataUrl: string | null }>({ type: "skin_image", skinId }, 15000);
		return r.data?.dataUrl ?? null;
	} catch {
		return null;
	}
}

export async function renameSkinRpc(skinId: string, name: string): Promise<RpcSkin | null> {
	const r = await sendCommandAwait<{ skin: RpcSkin | null }>({ type: "skin_rename", skinId, name }, 10000);
	return r.data?.skin ?? null;
}

/** 订阅皮肤变更（扩展广播）。返回退订函数。 */
export function subscribeSkinChanges(handler: () => void): () => void {
	let unlisten: (() => void) | undefined;
	void subscribeEvents((event) => {
		if (event.type !== "CUSTOM_MESSAGE") return;
		const payload = event.payload as { kind?: unknown; extension_id?: unknown } | undefined;
		if (payload?.extension_id === "skins" && payload?.kind === "skin_changed") {
			handler();
		}
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
}

// ---------------------------------------------------------------------------
// 上妆引擎：CSS 变量 / 背景图层
// ---------------------------------------------------------------------------

const SKIN_STYLE_ID = "zharness-skin-vars";
const CACHE_CSS_KEY = "zharness-skin-css";
const CACHE_ID_KEY = "zharness-skin-id";
const CACHE_IMAGE_KEY = "zharness-skin-image";

/** 当前已应用的皮肤 id（GUI 状态用；"default" = 默认皮肤）。 */
let appliedSkinId = "default";

export function getAppliedSkinId(): string {
	return appliedSkinId;
}

function upsertStyleElement(css: string): void {
	let style = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement("style");
		style.id = SKIN_STYLE_ID;
		document.head.appendChild(style);
	}
	style.textContent = css;
}

function removeStyleElement(): void {
	document.getElementById(SKIN_STYLE_ID)?.remove();
}

/** 生成色板皮肤的覆盖 CSS（html:root / html.dark 提升优先级，压过 index.css）。 */
function paletteCss(skin: RpcSkin): string {
	const lines: string[] = [];
	const apply = (selector: string, vars: Record<string, string>) => {
		const body = Object.entries(vars)
			.map(([k, v]) => `\t${k}: ${v};`)
			.join("\n");
		if (body) lines.push(`${selector} {\n${body}\n}`);
	};
	if (skin.colors?.light) apply("html:root", skin.colors.light);
	if (skin.colors?.dark) apply("html.dark", skin.colors.dark);
	return lines.join("\n");
}

/** 生成图片皮肤的背景图层 CSS（body::before 图层 + body::after 遮罩）。 */
function imageCss(skin: RpcSkin, dataUrl: string): string {
	const dim = Math.min(0.9, Math.max(0, skin.image?.dim ?? 0.45));
	const blur = Math.min(12, Math.max(0, skin.image?.blur ?? 0));
	return `
html:root, html.dark { --bg: transparent; }
body::before {
	content: "";
	position: fixed;
	inset: 0;
	z-index: -2;
	background-image: url("${dataUrl}");
	background-size: cover;
	background-position: center;
	background-repeat: no-repeat;
	filter: blur(${blur}px);
	transform: scale(1.03); /* 模糊边缘外扩，避免露边 */
}
body::after {
	content: "";
	position: fixed;
	inset: 0;
	z-index: -1;
	background: rgba(249, 250, 251, ${dim});
	pointer-events: none;
}
html.dark body::after {
	background: rgba(11, 11, 13, ${dim});
}
`;
}

/** 缓存写入（localStorage 配额不足/不可用时静默跳过 —— 仅影响启动防闪）。 */
function cacheSkin(css: string | null, skinId: string, imageDataUrl?: string | null): void {
	try {
		if (css === null) {
			localStorage.removeItem(CACHE_CSS_KEY);
			localStorage.removeItem(CACHE_ID_KEY);
		} else {
			localStorage.setItem(CACHE_CSS_KEY, css);
			localStorage.setItem(CACHE_ID_KEY, skinId);
		}
		if (imageDataUrl === null) {
			localStorage.removeItem(CACHE_IMAGE_KEY);
		} else if (imageDataUrl) {
			localStorage.setItem(CACHE_IMAGE_KEY, imageDataUrl);
		}
	} catch {
		/* 配额满或禁用 —— 跳过缓存 */
	}
}

/**
 * 应用皮肤到 DOM（纯前端渲染，幂等）。
 * - default：移除注入样式与缓存；
 * - 内置色板：注入 light/dark 两套 CSS 变量并缓存（开机防闪）；
 * - 自定义图片：注入背景图层（图片 dataUrl 由调用方提供），遮罩/模糊随 meta。
 */
export function renderSkin(skin: RpcSkin | null, imageDataUrl?: string | null): void {
	if (!skin || skin.id === "default" || (!skin.colors && !(skin.image && imageDataUrl))) {
		appliedSkinId = skin?.id && skin.id !== "default" ? skin.id : "default";
		if (!skin || skin.id === "default") appliedSkinId = "default";
		removeStyleElement();
		cacheSkin(null, "default", null);
		return;
	}
	if (skin.colors) {
		const css = paletteCss(skin);
		upsertStyleElement(css);
		cacheSkin(css, skin.id, null);
		appliedSkinId = skin.id;
		return;
	}
	if (skin.image && imageDataUrl) {
		upsertStyleElement(imageCss(skin, imageDataUrl));
		cacheSkin(null, skin.id, imageDataUrl);
		appliedSkinId = skin.id;
	}
}

/** 启动即时上妆：回放缓存的色板皮肤 / 图片皮肤（React 挂载前由 index.html 调用）。 */
export function bootFromCache(): void {
	try {
		const id = localStorage.getItem(CACHE_ID_KEY);
		const css = localStorage.getItem(CACHE_CSS_KEY);
		const image = localStorage.getItem(CACHE_IMAGE_KEY);
		if (css) {
			upsertStyleElement(css);
			appliedSkinId = id ?? "default";
		} else if (image && id) {
			// 图片皮肤的开机回放：仅注入图片图层（遮罩/模糊参数由 RPC 对账修正）。
			upsertStyleElement(
				`body::before { content: ""; position: fixed; inset: 0; z-index: -2; background-image: url("${image}"); background-size: cover; background-position: center; }`,
			);
			appliedSkinId = id;
		}
	} catch {
		/* storage 不可用 */
	}
}

/**
 * 拉取状态并整体上妆（skin_changed / 首次挂载时调用）。
 * 自定义图片皮肤需要额外拉图；图片缺失时保持色板不动并静默。
 */
export async function refreshSkinFromAgent(): Promise<RpcSkinState> {
	const state = await fetchSkinState();
	const active = state.skins.find((s) => s.id === state.activeSkinId) ?? null;
	if (active?.image) {
		const dataUrl = await fetchSkinImage(active.id);
		renderSkin(active, dataUrl);
	} else {
		renderSkin(active);
	}
	return state;
}
