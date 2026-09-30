import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 自定义日期选取器(高保真 22 画板「生效日期区间 / 单次」)。
 * 原生 date 输入的弹出日历为浏览器默认样式,与设计语言不符;此组件用与
 * 应用一致的下拉面板(surface 底 / r4 / accent 选中 / 周一起始)替代,
 * 触发器外观与表单输入框一致,值为 "YYYY-MM-DD",空串 = 未选择。
 */

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmt = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

export function DatePicker({
	value,
	placeholder,
	onChange,
	showWeekday,
	className,
	align = "left",
}: {
	value: string;
	placeholder?: string;
	onChange: (next: string) => void;
	/** 触发器文本附带星期(单次模式,设计稿 "2026-10-30 周三")。 */
	showWeekday?: boolean;
	className?: string;
	align?: "left" | "right";
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<{ y: number; m: number }>(() => {
		const now = new Date();
		return { y: now.getFullYear(), m: now.getMonth() + 1 };
	});
	const rootRef = useRef<HTMLDivElement>(null);

	// 打开时视图定位到已选日期(或今天)。
	useEffect(() => {
		if (!open) return;
		const base = value ? new Date(`${value}T00:00`) : new Date();
		if (!Number.isNaN(base.getTime())) setView({ y: base.getFullYear(), m: base.getMonth() + 1 });
	}, [open, value]);

	// 点击面板外关闭。
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// 周一起始的网格:前置空格数 + 当月天数。
	const grid = useMemo(() => {
		const firstDow = new Date(view.y, view.m - 1, 1).getDay(); // 0=周日
		const offset = (firstDow + 6) % 7;
		const days = new Date(view.y, view.m, 0).getDate();
		return { offset, days };
	}, [view]);

	const todayStr = (() => {
		const n = new Date();
		return fmt(n.getFullYear(), n.getMonth() + 1, n.getDate());
	})();

	// 星期短标签:zh 从「周一」取「一」,en 保留 Mon;周一起始排序。
	const weekdayHeads = [1, 2, 3, 4, 5, 6, 0].map((d) =>
		t(`automation.weekdays.${d}`).replace(/^周/, ""),
	);

	const weekdayOf = (v: string) => {
		const d = new Date(`${v}T00:00`).getDay();
		return t(`automation.weekdays.${d}`);
	};

	const shiftMonth = (delta: number) => {
		setView((prev) => {
			const m = prev.m + delta;
			if (m < 1) return { y: prev.y - 1, m: 12 };
			if (m > 12) return { y: prev.y + 1, m: 1 };
			return { y: prev.y, m };
		});
	};

	return (
		<div ref={rootRef} className={cn("relative", className)}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex h-9 w-full items-center justify-between gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
					open ? "border-accent" : "border-border hover:border-accent/40",
					"bg-surface",
					value ? "text-fg" : "text-muted",
				)}
			>
				<span className="min-w-0 truncate">
					{value ? (showWeekday ? `${value} ${weekdayOf(value)}` : value) : placeholder}
				</span>
				<Calendar className="h-3.5 w-3.5 shrink-0 text-muted" />
			</button>
			{open && (
				<div
					className={cn(
						"absolute top-full z-30 mt-1 w-[280px] rounded-[4px] border border-border bg-surface p-2.5 shadow-lg",
						align === "right" ? "right-0" : "left-0",
					)}
				>
					{/* 年月导航 */}
					<div className="mb-1.5 flex items-center justify-between">
						<button
							type="button"
							onClick={() => shiftMonth(-1)}
							className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>
						<span className="text-sm font-semibold text-fg">
							{view.y} {t(`automation.months.${view.m}`)}
						</span>
						<button
							type="button"
							onClick={() => shiftMonth(1)}
							className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
					{/* 星期表头(周一起始) */}
					<div className="grid grid-cols-7">
						{weekdayHeads.map((label, i) => (
							<span key={i} className="flex h-7 items-center justify-center text-xs text-muted">
								{label}
							</span>
						))}
					</div>
					{/* 日期网格 */}
					<div className="grid grid-cols-7">
						{Array.from({ length: grid.offset }, (_, i) => (
							<span key={`blank-${i}`} />
						))}
						{Array.from({ length: grid.days }, (_, i) => i + 1).map((d) => {
							const dayStr = fmt(view.y, view.m, d);
							const selected = dayStr === value;
							const isToday = dayStr === todayStr;
							return (
								<button
									key={d}
									type="button"
									onClick={() => {
										onChange(dayStr);
										setOpen(false);
									}}
									className={cn(
										"mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors",
										selected
											? "bg-accent font-semibold text-accent-fg"
											: isToday
												? "border border-accent/60 text-accent hover:bg-accent/10"
												: "text-fg hover:bg-surface-2",
									)}
								>
									{d}
								</button>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
