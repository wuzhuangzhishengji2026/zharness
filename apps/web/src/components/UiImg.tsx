import { cn } from "@/lib/utils";

/**
 * 切图图标包装:固定占位尺寸,src 用 Vite public 绝对路径。
 *
 * - 默认 16px,与原 lucide 的 h-4 w-4 一致;
 * - 类名继承父元素的色调(用 currentColor 友好度有限,所以保留 PNG 原色;
 *   如需变色,改用 mask-image + background-color 模式)。
 */
export function UiImg({
	src,
	alt = "",
	className,
	size = 16,
}: {
	src: string;
	alt?: string;
	className?: string;
	size?: number;
}) {
	return (
		<img
			src={src}
			alt={alt}
			aria-hidden={alt === "" ? true : undefined}
			draggable={false}
			width={size}
			height={size}
			className={cn("shrink-0 select-none", className)}
		/>
	);
}

/**
 * 侧栏 / tab 一类「默认 + 激活」二态切图图标。
 * 父级通过 active 状态切换两套 png。容器尺寸固定,图标居中。
 */
export function ToggleIcon({
	defaultSrc,
	activeSrc,
	alt,
	active = false,
	size = 18,
	className,
}: {
	defaultSrc: string;
	activeSrc: string;
	alt: string;
	active?: boolean;
	size?: number;
	className?: string;
}) {
	return (
		<img
			src={active ? activeSrc : defaultSrc}
			alt={alt}
			aria-hidden={alt === "" ? true : undefined}
			draggable={false}
			width={size}
			height={size}
			className={cn("shrink-0 select-none", className)}
		/>
	);
}