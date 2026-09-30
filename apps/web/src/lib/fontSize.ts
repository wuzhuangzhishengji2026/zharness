import { useEffect, useState } from "react";

/** 全局界面字号 — 通过根元素 font-size 缩放所有 rem 尺寸。 */
export type FontSize = "small" | "standard" | "large";

export const FONT_SIZE_PX: Record<FontSize, number> = {
	small: 14,
	standard: 16,
	large: 18,
};

const STORAGE_KEY = "zharness-font-size";

export function getFontSize(): FontSize {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "small" || saved === "standard" || saved === "large") return saved;
	} catch {
		/* ignore */
	}
	return "standard";
}

export function applyFontSize(size: FontSize): void {
	document.documentElement.style.fontSize = `${FONT_SIZE_PX[size]}px`;
}

export function setFontSize(size: FontSize): void {
	applyFontSize(size);
	try {
		localStorage.setItem(STORAGE_KEY, size);
	} catch {
		/* ignore */
	}
	// 通知 useFontSize 监听者 (storage 事件不触发同页更新)。
	window.dispatchEvent(new CustomEvent("zharness-font-size-change", { detail: size }));
}

export function useFontSize(): [FontSize, (size: FontSize) => void] {
	const [size, setSizeState] = useState<FontSize>(getFontSize);
	useEffect(() => {
		const onChange = (e: Event) => setSizeState((e as CustomEvent<FontSize>).detail ?? getFontSize());
		window.addEventListener("zharness-font-size-change", onChange);
		return () => window.removeEventListener("zharness-font-size-change", onChange);
	}, []);
	return [size, setFontSize];
}
