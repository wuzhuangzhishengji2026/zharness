import type { ReactNode } from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleTheme, useTheme } from "@/lib/theme";

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

export function Card({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-surface px-5 py-4 shadow-sm",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<div className="mb-6 flex items-start justify-between gap-4">
			<div className="flex items-start gap-2.5">
				<span className="mt-1.5 h-5 w-1 shrink-0 rounded-full bg-accent" />
				<div>
					<h1 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-fg">
						{title}
						{description && (
							<span className="text-xs font-normal text-muted">{description}</span>
						)}
					</h1>
				</div>
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}

const badgeTones: Record<Tone, string> = {
	neutral: "bg-surface-2 text-muted",
	success: "bg-success/10 text-success",
	warning: "bg-warning/10 text-warning",
	danger: "bg-danger/10 text-danger",
	accent: "bg-accent/10 text-accent",
};

export function Badge({
	children,
	tone = "neutral",
	className,
}: {
	children: ReactNode;
	tone?: Tone;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
				badgeTones[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

const buttonTones: Record<"solid" | "soft" | "outline" | "ghost", Record<Tone, string>> = {
	solid: {
		accent: "bg-accent text-accent-fg hover:bg-accent/90",
		danger: "bg-danger text-white hover:bg-danger/90",
		success: "bg-success text-white hover:bg-success/90",
		warning: "bg-warning text-white hover:bg-warning/90",
		neutral: "border border-border bg-surface text-fg hover:bg-surface-2",
	},
	soft: {
		accent: "bg-accent/10 text-accent hover:bg-accent/15",
		danger: "bg-danger/10 text-danger hover:bg-danger/15",
		success: "bg-success/10 text-success hover:bg-success/15",
		warning: "bg-warning/10 text-warning hover:bg-warning/15",
		neutral: "bg-surface-2 text-fg hover:bg-border/60",
	},
	outline: {
		accent: "border border-accent/60 text-accent hover:bg-accent/10",
		danger: "border border-danger/60 text-danger hover:bg-danger/10",
		success: "border border-success/60 text-success hover:bg-success/10",
		warning: "border border-warning/60 text-warning hover:bg-warning/10",
		neutral: "border border-border text-fg hover:bg-surface-2",
	},
	ghost: {
		accent: "text-accent hover:bg-accent/10",
		danger: "text-danger hover:bg-danger/10",
		success: "text-success hover:bg-success/10",
		warning: "text-warning hover:bg-warning/10",
		neutral: "text-muted hover:bg-surface-2 hover:text-fg",
	},
};

const buttonSizes = {
	sm: "h-7 gap-1 px-2.5 text-xs",
	md: "h-9 gap-1.5 px-3.5 text-sm",
	lg: "h-10 gap-2 px-4 text-sm",
};

export function Button({
	children,
	tone = "accent",
	variant = "solid",
	size = "md",
	iconLeft,
	iconRight,
	loading,
	fullWidth,
	disabled,
	onClick,
	type = "button",
	title,
	className,
}: {
	children?: ReactNode;
	tone?: Tone;
	variant?: "solid" | "soft" | "outline" | "ghost";
	size?: "sm" | "md" | "lg";
	iconLeft?: ReactNode;
	iconRight?: ReactNode;
	loading?: boolean;
	fullWidth?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	type?: "button" | "submit" | "reset";
	title?: string;
	className?: string;
}) {
	return (
		<button
			type={type}
			title={title}
			disabled={disabled || loading}
			onClick={onClick}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
				"disabled:cursor-not-allowed disabled:opacity-50",
				buttonSizes[size],
				buttonTones[variant][tone],
				fullWidth && "w-full",
				className,
			)}
		>
			{loading ? <Spinner className="h-3.5 w-3.5" /> : iconLeft}
			{children}
			{iconRight}
		</button>
	);
}

export function StatusDot({
	tone,
}: {
	tone: "success" | "warning" | "danger" | "neutral";
}) {
	const color = {
		success: "bg-success",
		warning: "bg-warning",
		danger: "bg-danger",
		neutral: "bg-muted",
	}[tone];
	return (
		<span className="relative inline-flex h-2 w-2">
			{tone === "success" && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
						color,
					)}
				/>
			)}
			<span className={cn("relative inline-block h-2 w-2 rounded-full", color)} />
		</span>
	);
}

export function Spinner({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
				className,
			)}
			role="status"
			aria-label="loading"
		/>
	);
}

export function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<label className="block">
			<span className="label">{label}</span>
			{children}
			{hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
		</label>
	);
}

export function EmptyState({
	title,
	description,
	action,
	icon,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
	icon?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
			{icon && <div className="mb-1 text-muted/60">{icon}</div>}
			<p className="text-sm font-medium text-fg">{title}</p>
			{description && <p className="text-xs text-muted">{description}</p>}
			{action && <div className="mt-3">{action}</div>}
		</div>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	const { t } = useTranslation();
	return (
		<div className="mb-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
			<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
			<div className="min-w-0">
				<p className="text-xs font-semibold text-danger">{t("common.error")}</p>
				<p className="text-xs text-fg">{message}</p>
			</div>
		</div>
	);
}

export function Modal({
	open,
	onClose,
	title,
	children,
	footer,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="w-full max-w-md rounded-xl bg-surface shadow-2xl">
				<div className="border-b border-border px-5 py-3.5">
					<h2 className="text-sm font-semibold text-fg">{title}</h2>
				</div>
				<div className="px-5 py-4">{children}</div>
				{footer && (
					<div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}

/** Confirmation dialog matching the 首页03 design: warning icon + title +
 * description + confirm/cancel actions. */
export function ConfirmDialog({
	open,
	onClose,
	onConfirm,
	title,
	description,
	confirmText,
	cancelText,
}: {
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
	title: string;
	description?: string;
	confirmText?: string;
	cancelText?: string;
}) {
	const { t } = useTranslation();
	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
			<div className="w-full max-w-sm rounded-xl bg-surface px-6 py-6 shadow-2xl">
				<div className="flex items-start gap-3">
					<AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
					<div className="min-w-0">
						<h2 className="text-sm font-semibold text-fg">{title}</h2>
						{description && (
							<p className="mt-1.5 text-xs leading-relaxed text-muted">{description}</p>
						)}
					</div>
				</div>
				<div className="mt-6 flex items-center justify-center gap-3">
					<Button tone="accent" onClick={onConfirm} className="min-w-24">
						{confirmText ?? t("common.confirm")}
					</Button>
					<Button tone="neutral" variant="outline" onClick={onClose} className="min-w-24">
						{cancelText ?? t("common.cancel")}
					</Button>
				</div>
			</div>
		</div>
	);
}

/** Tab switcher. `pill` matches the 配置管理 design (active = filled accent
 * pill); `underline` matches the right-dock design (active = accent text +
 * bottom border). */
export function Tabs({
	tabs,
	active,
	onChange,
	variant = "pill",
	className,
}: {
	tabs: { key: string; label: ReactNode; icon?: ReactNode }[];
	active: string;
	onChange: (key: string) => void;
	variant?: "pill" | "underline";
	className?: string;
}) {
	if (variant === "underline") {
		return (
			<div className={cn("flex items-center gap-5 border-b border-border", className)}>
				{tabs.map((tab) => {
					const isActive = tab.key === active;
					return (
						<button
							key={tab.key}
							type="button"
							onClick={() => onChange(tab.key)}
							className={cn(
								"-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2.5 pt-1 text-sm transition-colors",
								isActive
									? "border-accent font-medium text-accent"
									: "border-transparent text-muted hover:text-fg",
							)}
						>
							{tab.icon}
							{tab.label}
						</button>
					);
				})}
			</div>
		);
	}
	return (
		<div className={cn("flex items-center gap-1", className)}>
			{tabs.map((tab) => {
				const isActive = tab.key === active;
				return (
					<button
						key={tab.key}
						type="button"
						onClick={() => onChange(tab.key)}
						className={cn(
							"flex h-8 items-center gap-1.5 rounded-full px-4 text-sm transition-colors",
							isActive
								? "bg-accent font-medium text-accent-fg"
								: "text-fg hover:bg-surface-2",
						)}
					>
						{tab.icon}
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}

/** Numbered pagination matching the 首页01 footer: ‹ 1 2 3 … N › + jump input. */
export function Pagination({
	page,
	pageCount,
	onChange,
	className,
}: {
	page: number;
	pageCount: number;
	onChange: (page: number) => void;
	className?: string;
}) {
	const { t } = useTranslation();
	if (pageCount < 1) return null;

	// Window of up to 5 page numbers around the current page, always
	// including the last page (with an ellipsis gap when needed).
	const pages: (number | "…")[] = [];
	const windowSize = 5;
	let start = Math.max(1, Math.min(page - 2, pageCount - windowSize + 1));
	const end = Math.min(pageCount, start + windowSize - 1);
	start = Math.max(1, end - windowSize + 1);
	for (let p = start; p <= end; p++) pages.push(p);
	if (end < pageCount - 1) pages.push("…");
	if (end < pageCount) pages.push(pageCount);

	const btn =
		"flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs transition-colors";
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			<button
				type="button"
				disabled={page <= 1}
				onClick={() => onChange(page - 1)}
				className={cn(btn, "text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40")}
				aria-label={t("common.prevPage")}
			>
				<ChevronLeft className="h-3.5 w-3.5" />
			</button>
			{pages.map((p, i) =>
				p === "…" ? (
					<span key={`gap-${i}`} className="px-1 text-xs text-muted">
						…
					</span>
				) : (
					<button
						key={p}
						type="button"
						onClick={() => onChange(p)}
						className={cn(
							btn,
							p === page
								? "bg-accent font-medium text-accent-fg"
								: "text-fg hover:bg-surface-2",
						)}
					>
						{p}
					</button>
				),
			)}
			<button
				type="button"
				disabled={page >= pageCount}
				onClick={() => onChange(page + 1)}
				className={cn(btn, "text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40")}
				aria-label={t("common.nextPage")}
			>
				<ChevronRight className="h-3.5 w-3.5" />
			</button>
			<span className="ml-2 flex items-center gap-1 text-xs text-muted">
				{t("common.jumpTo")}
				<input
					type="number"
					min={1}
					max={pageCount}
					className="h-7 w-12 rounded border border-border bg-surface px-1.5 text-center text-xs text-fg focus:border-accent focus:outline-none"
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						const v = Number((e.target as HTMLInputElement).value);
						if (v >= 1 && v <= pageCount) onChange(v);
					}}
				/>
				{t("common.pageUnit")}
			</span>
		</div>
	);
}

/** Filter dropdown select styled after the 首页01 filter bar. */
export function FilterSelect({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label?: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	className?: string;
}) {
	return (
		<label className={cn("flex items-center gap-1.5 text-sm", className)}>
			{label && <span className="shrink-0 text-muted">{label}</span>}
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-8 cursor-pointer rounded-md border border-border bg-surface px-2 text-sm text-fg transition-colors hover:border-muted/50 focus:border-accent focus:outline-none"
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		</label>
	);
}

export function MiniSwitch({
	checked,
	onChange,
	disabled,
	tone = "green",
	"aria-label": ariaLabel,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	tone?: "green" | "accent";
	"aria-label"?: string;
}) {
	const onColor =
		tone === "accent"
			? "border-accent bg-accent/30"
			: "border-success bg-success/30";
	const onThumb = tone === "accent" ? "bg-accent" : "bg-success";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
				checked ? onColor : "border-border bg-surface-2",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			<span
				className={cn(
					"absolute h-3.5 w-3.5 rounded-full transition-transform",
					checked
						? `translate-x-4 ${onThumb}`
						: "translate-x-0.5 bg-muted",
				)}
			/>
		</button>
	);
}

export function ThemeToggle() {
	const { t } = useTranslation();
	const theme = useTheme();
	const isDark = theme === "dark";
	return (
		<Button
			tone="neutral"
			variant="ghost"
			size="sm"
			onClick={toggleTheme}
			title={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			iconLeft={<span className="text-xs">{isDark ? "☀" : "☾"}</span>}
		/>
	);
}

/**
 * A single menu entry. Either an action item (icon + label + click handler)
 * or a visual divider. Use the union shape to make dividers type-safe.
 */
export type ContextMenuItem =
	| {
			divider?: never;
			icon: typeof import("lucide-react").Folder;
			label: string;
			hint?: string;
			disabled?: boolean;
			danger?: boolean;
			onClick: () => void;
	  }
	| { divider: true };

export interface ContextMenuProps {
	/** Position in viewport coordinates (typically `e.clientX/Y`). */
	x: number;
	y: number;
	items: ContextMenuItem[];
	onDismiss: () => void;
}

/**
 * Floating context menu rendered as a `position: fixed` div with viewport
 * coordinates. Dismisses on outside mousedown or Escape (handled by the
 * caller via `onDismiss` — typically a window-level listener installed in
 * a `useEffect` while the menu is open).
 */
export function ContextMenu({ x, y, items, onDismiss }: ContextMenuProps) {
	// Clamp the menu inside the viewport so it doesn't overflow right/bottom
	// edges. Width/height are estimates (item widths vary); a simple upfront
	// clamp keeps it usable on narrow right docks.
	const minWidth = 208; // matches the min-w-52 class below
	const maxHeight = 360;
	const clampedX = Math.max(8, Math.min(x, window.innerWidth - minWidth - 8));
	const clampedY = Math.max(8, Math.min(y, window.innerHeight - maxHeight - 8));

	return (
		<div
			className="fixed z-50 min-w-52 rounded-lg border border-border bg-surface py-1 shadow-lg"
			style={{ left: clampedX, top: clampedY }}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{items.map((item, i) => (
				item.divider ? (
					<div key={i} className="my-1 h-px bg-border" />
				) : (
					<ContextMenuRow
						key={i}
						item={item}
						onClick={() => {
							if (item.disabled) return;
							onDismiss();
							item.onClick();
						}}
					/>
				)
			))}
		</div>
	);
}

function ContextMenuRow({
	item,
	onClick,
}: {
	item: Exclude<ContextMenuItem, { divider: true }>;
	onClick: () => void;
}) {
	const Icon = item.icon;
	return (
		<button
			type="button"
			disabled={item.disabled}
			onClick={onClick}
			title={item.hint}
			className={cn(
				"flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors",
				item.disabled
					? "cursor-not-allowed text-muted/40"
					: item.danger
						? "text-danger hover:bg-danger/10 hover:text-danger"
						: "text-fg hover:bg-accent/10 hover:text-accent",
			)}
		>
			<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate">{item.label}</span>
				{item.hint && (
					<span className="truncate text-[10px] font-normal text-muted">{item.hint}</span>
				)}
			</span>
		</button>
	);
}
