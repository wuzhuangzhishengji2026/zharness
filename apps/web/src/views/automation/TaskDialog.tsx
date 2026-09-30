import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, X } from "lucide-react";
import type { ScheduledTaskSummary, Weekday } from "@zharness/protocol";
import { isMainChatCwd } from "@/components/Layout";
import type { WorkspaceMeta } from "@/lib/types";
import { createScheduledTask, parseManagedCron, updateScheduledTask } from "@/lib/scheduler";
import { cn } from "@/lib/utils";
import { DatePicker } from "@/views/automation/DatePicker";

/**
 * 创建/编辑定时任务弹窗(高保真 22 画板,自 AutomationView 抽出供列表页与
 * 会话页悬浮卡片共用)。
 * - 640px 弹窗(r20),执行频率分段控件(周期/按间隔/单次;
 *   cron 不再作为选项,仅编辑历史 cron 任务时保留其表达式),
 *   周期含 每天每周每月每年(每年借 cron `分 时 日 月 *` 表达),按间隔支持
 *   星期限制(非空时借 cron 步进 + 星期受限表达);单次隐藏生效日期区间;
 *   高级设置三列(运行/并发/超时)+ 已启用复选。
 */

/** 表单的执行频率三分段(设计稿);cron 不再作为选项,仅编辑历史 cron 任务时内部保留。 */
type FreqMode = "cycle" | "interval" | "once" | "cron";
type CycleUnit = "daily" | "weekly" | "monthly" | "yearly";

interface FormState {
	name: string;
	/** "main" 或 workspace_id。 */
	workspaceKey: string;
	description: string;
	freqMode: FreqMode;
	cycleUnit: CycleUnit;
	weekdays: number[];
	daysOfMonth: number[];
	/** 每年(cycleUnit=yearly):月份 1-12 与日期 1-31(借 cron 引擎,设计稿 22 画板)。 */
	yearlyMonth: number;
	yearlyDay: number;
	time: string;
	intervalN: number;
	intervalUnit: "minute" | "hour";
	/** 按间隔的星期限制(空=每天;非空时借 cron 小时/分钟步进 + 星期受限表达)。 */
	intervalWeekdays: number[];
	onceAt: string;
	cronExpr: string;
	dateStart: string;
	dateEnd: string;
	prompt: string;
	runTarget: "pinned" | "new";
	concurrency: "skip" | "queue" | "preempt";
	timeoutMinutes: number;
	enabled: boolean;
}

const DEFAULT_FORM: FormState = {
	name: "",
	workspaceKey: "main",
	description: "",
	freqMode: "cycle",
	cycleUnit: "daily",
	weekdays: [1],
	daysOfMonth: [1],
	yearlyMonth: 1,
	yearlyDay: 1,
	time: "09:00",
	intervalN: 2,
	intervalUnit: "hour",
	intervalWeekdays: [],
	onceAt: "",
	cronExpr: "",
	dateStart: "",
	dateEnd: "",
	prompt: "",
	runTarget: "pinned",
	concurrency: "skip",
	timeoutMinutes: 0,
	enabled: true,
};

function parseTimeOfDay(time: string): { hour: number; minute: number } | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return { hour, minute };
}

function formToSchedule(form: FormState): { schedule: ScheduledTaskSummary["schedule"] } | { error: string } {
	const time = parseTimeOfDay(form.time);
	switch (form.freqMode) {
		case "cycle": {
			if (!time) return { error: "invalid-time" };
			if (form.cycleUnit === "weekly") {
				if (form.weekdays.length === 0) return { error: "no-weekday" };
				return { schedule: { mode: "weekly", weekdays: form.weekdays as Weekday[], times: [time] } };
			}
			if (form.cycleUnit === "monthly") {
				if (form.daysOfMonth.length === 0) return { error: "no-day" };
				return { schedule: { mode: "monthly", daysOfMonth: form.daysOfMonth, times: [time] } };
			}
			if (form.cycleUnit === "yearly") {
				// 后端无 yearly 模式,借 cron `分 时 日 月 *` 表达(引擎按标准语义展开)。
				const expr = `${time.minute} ${time.hour} ${form.yearlyDay} ${form.yearlyMonth} *`;
				return { schedule: { mode: "cron", cron: { expression: expr } } };
			}
			return { schedule: { mode: "daily", times: [time] } };
		}
		case "interval": {
			const n = Math.floor(form.intervalN);
			if (!Number.isFinite(n) || n < 1 || n > 10080) return { error: "invalid-interval" };
			if (form.intervalWeekdays.length > 0) {
				// every_n 模式不支持星期限制,借 cron 表达;步进超界会破坏 cron 语义,先校验。
				const max = form.intervalUnit === "hour" ? 23 : 59;
				if (n > max) return { error: "invalid-interval-cron" };
				const dow = [...new Set(form.intervalWeekdays)].sort((a, b) => a - b).join(",");
				const expr = form.intervalUnit === "hour" ? `0 */${n} * * ${dow}` : `*/${n} * * * ${dow}`;
				return { schedule: { mode: "cron", cron: { expression: expr } } };
			}
			return {
				schedule: {
					mode: form.intervalUnit === "hour" ? "every_n_hours" : "every_n_minutes",
					everyN: { n, unit: form.intervalUnit },
				},
			};
		}
		case "once": {
			const at = form.onceAt ? new Date(form.onceAt).getTime() : NaN;
			if (!Number.isFinite(at)) return { error: "invalid-once" };
			return { schedule: { mode: "once", startAt: at } };
		}
		case "cron": {
			if (!form.cronExpr.trim()) return { error: "invalid-cron" };
			return { schedule: { mode: "cron", cron: { expression: form.cronExpr.trim() } } };
		}
	}
}

/** 生效日期区间(非单次模式):dateStart 0 点 → dateEnd 23:59:59.999。 */
function applyDateRange(form: FormState, schedule: ScheduledTaskSummary["schedule"]): void {
	if (form.freqMode === "once") return;
	if (form.dateStart) {
		const d = new Date(`${form.dateStart}T00:00`);
		if (!Number.isNaN(d.getTime())) schedule.startAt = d.getTime();
	}
	if (form.dateEnd) {
		const d = new Date(`${form.dateEnd}T23:59:59.999`);
		if (!Number.isNaN(d.getTime())) schedule.endAt = d.getTime();
	}
}

function taskToForm(task: ScheduledTaskSummary): FormState {
	const spec = task.schedule;
	// 受控 cron(本前端生成的 每年 / 间隔+星期)反解回可视化表单;其余保持 cron 高级模式。
	const managed = spec.mode === "cron" && spec.cron?.expression ? parseManagedCron(spec.cron.expression) : null;
	const freqMode: FreqMode = managed
		? (managed.kind === "yearly" ? "cycle" : "interval")
		: spec.mode === "cron" ? "cron"
			: spec.mode === "once" ? "once"
				: spec.mode === "every_n_minutes" || spec.mode === "every_n_hours" ? "interval"
					: "cycle";
	const cycleUnit: CycleUnit = managed?.kind === "yearly"
		? "yearly"
		: spec.mode === "weekly" ? "weekly" : spec.mode === "monthly" ? "monthly" : "daily";
	const firstTime = managed?.kind === "yearly"
		? managed.time
		: spec.times?.[0];
	const pad = (n: number) => String(n).padStart(2, "0");
	const toDateInput = (ms?: number) =>
		typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "";
	return {
		name: task.name,
		workspaceKey: task.scope === "main" ? "main" : (task.workspaceId ?? "main"),
		description: task.description ?? "",
		freqMode,
		cycleUnit,
		weekdays: spec.weekdays ?? [1],
		daysOfMonth: spec.daysOfMonth ?? [1],
		yearlyMonth: managed?.kind === "yearly" ? managed.month : 1,
		yearlyDay: managed?.kind === "yearly" ? managed.day : 1,
		time: firstTime ? `${pad(firstTime.hour)}:${pad(firstTime.minute)}` : "09:00",
		intervalN: managed?.kind === "interval" ? managed.n : (spec.everyN?.n ?? 2),
		intervalUnit: managed?.kind === "interval" ? managed.unit : (spec.everyN?.unit ?? "hour"),
		intervalWeekdays: managed?.kind === "interval" ? managed.weekdays : [],
		onceAt: typeof spec.startAt === "number" ? new Date(spec.startAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "",
		cronExpr: spec.cron?.expression ?? "",
		dateStart: freqMode === "once" ? "" : toDateInput(spec.startAt),
		dateEnd: freqMode === "once" ? "" : toDateInput(spec.endAt),
		prompt: task.prompt,
		runTarget: task.sessionTarget?.kind === "new" ? "new" : "pinned",
		concurrency: task.concurrencyPolicy ?? "skip",
		timeoutMinutes: task.timeoutMinutes ?? 0,
		enabled: task.enabled,
	};
}

const inputClass =
	"h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none";

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
	return (
		<label className="mb-1.5 block text-sm text-fg">
			{children}
			{required && <span className="ml-0.5 text-danger">*</span>}
		</label>
	);
}

/** 星期多选 chips(设计稿 22 画板:周一起始、周日收尾)。每周/按间隔共用。 */
function WeekdayChips({ value, onChange }: { value: number[]; onChange: (next: number[]) => void }) {
	const { t } = useTranslation();
	const order = [1, 2, 3, 4, 5, 6, 0];
	return (
		<div className="flex flex-wrap items-center gap-1">
			{order.map((day) => (
				<button
					key={day}
					type="button"
					onClick={() =>
						onChange(
							value.includes(day)
								? value.filter((d) => d !== day)
								: [...value, day].sort((a, b) => a - b),
						)
					}
					className={cn(
						"h-7 min-w-7 rounded-full border px-2 text-xs transition-colors",
						value.includes(day)
							? "border-accent bg-accent font-medium text-accent-fg"
							: "border-border text-muted hover:border-accent/40",
					)}
				>
					{t(`automation.weekdays.${day}`)}
				</button>
			))}
		</div>
	);
}

/** 创建/编辑弹窗(设计稿 s0:640px r20,横向表单=右对齐标签列+输入列)。 */
export function TaskDialog({
	open,
	editing,
	workspaces,
	currentWorkspace,
 onClose,
	onSaved,
}: {
	open: boolean;
	editing: ScheduledTaskSummary | null;
	workspaces: WorkspaceMeta[];
	currentWorkspace?: string | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { t } = useTranslation();
	const [form, setForm] = useState<FormState>(DEFAULT_FORM);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setError("");
		setSaving(false);
		if (editing) {
			setForm(taskToForm(editing));
		} else {
			// 默认所属项目:当前工作区(主窗口时为 main/本地任务)。
			const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
			const current = workspaces.find((ws) => norm(ws.cwd) === norm(currentWorkspace ?? ""));
			setForm({ ...DEFAULT_FORM, workspaceKey: current?.workspace_id ?? "main" });
		}
	}, [open, editing, workspaces, currentWorkspace]);

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const selectedWorkspace = workspaces.find((ws) => ws.workspace_id === form.workspaceKey);
	const scopeInfo = selectedWorkspace
		? { scope: "workspace" as const, workspaceId: selectedWorkspace.workspace_id }
		: { scope: "main" as const };
	// 「固定到此会话」跨项目时没有"此会话"可固定:保持 pinned 无 id 落盘,
	// 由拥有该项目的 sidecar 在首次派发时兜底固定到自己的活跃会话。
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const isCurrentProject = selectedWorkspace
		? norm(selectedWorkspace.cwd) === norm(currentWorkspace ?? "\0")
		: isMainChatCwd(currentWorkspace ?? null);

	const handleSave = async () => {
		if (!form.prompt.trim()) {
			setError(t("automation.errors.promptRequired"));
			return;
		}
		const built = formToSchedule(form);
		if ("error" in built) {
			setError(t(`automation.errors.${built.error}`));
			return;
		}
		const schedule = { ...built.schedule };
		applyDateRange(form, schedule);
		setSaving(true);
		setError("");
		try {
			if (editing) {
				await updateScheduledTask(scopeInfo, editing.id, {
					name: form.name.trim() || form.prompt.slice(0, 30),
					prompt: form.prompt,
					description: form.description.trim() || null,
					schedule,
					enabled: form.enabled,
					sessionTarget:
						form.runTarget === "new"
							? { kind: "new", purpose: form.name.trim() || "scheduled" }
							: { kind: "pinned" },
					concurrencyPolicy: form.concurrency,
					timeoutMinutes: form.timeoutMinutes,
				});
			} else {
				await createScheduledTask(scopeInfo, {
					name: form.name.trim() || form.prompt.slice(0, 30),
					prompt: form.prompt,
					description: form.description.trim() || undefined,
					schedule,
					enabled: form.enabled,
					sessionTarget:
						form.runTarget === "new"
							? { kind: "new", purpose: form.name.trim() || "scheduled" }
							: { kind: "pinned" },
					concurrencyPolicy: form.concurrency,
					timeoutMinutes: form.timeoutMinutes,
				});
			}
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	if (!open) return null;

/** 横向表单的右对齐标签列(设计稿 s0:标签列宽 ~92px,右对齐)。 */
const formRowLabel = "w-[92px] shrink-0 text-right text-sm text-fg";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
			<div
				className="flex max-h-[90vh] w-[640px] flex-col rounded-[20px] bg-surface shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				{/* 标题 + 分隔线(设计稿 y=218) */}
				<div className="flex items-center justify-between border-b border-border px-6 py-4">
					<h2 className="text-xl font-semibold text-fg">
						{editing ? t("automation.editTitle") : t("automation.createTitle")}
					</h2>
					<button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
					{/* 任务名称 */}
					<div className="flex items-center gap-2.5">
						<span className={formRowLabel}>{t("automation.fields.name")}</span>
						<input
							className={cn(inputClass, "flex-1")}
							value={form.name}
							onChange={(e) => set("name", e.target.value)}
							placeholder={t("automation.fields.namePlaceholder")}
						/>
					</div>
					{/* 所属项目 */}
					<div className="flex items-center gap-2.5">
						<span className={formRowLabel}>{t("automation.fields.project")}</span>
						<div className="relative flex-1">
							<select
								className={cn(inputClass, "appearance-none pr-8")}
								value={form.workspaceKey}
								onChange={(e) => set("workspaceKey", e.target.value)}
							>
								<option value="main">{t("automation.fields.mainProject")}</option>
								{workspaces.map((ws) => (
									<option key={ws.workspace_id} value={ws.workspace_id}>
										{ws.cwd.split(/[\\/]/).pop() || ws.cwd}
									</option>
								))}
							</select>
							<ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
						</div>
					</div>
					{/* 任务内容(选填, 120px 文本域) */}
					<div className="flex items-start gap-2.5">
						<span className={cn(formRowLabel, "pt-2")}>{t("automation.fields.description")}</span>
						<textarea
							className={cn(inputClass, "h-[120px] flex-1 resize-none py-2")}
							value={form.description}
							onChange={(e) => set("description", e.target.value)}
							placeholder={t("common.optional")}
						/>
					</div>
					{/* 执行频率:分段控件(选中=实心蓝底白字, 78x30 r4) + 模式参数 */}
					<div className="flex items-start gap-2.5">
						<span className={cn(formRowLabel, "pt-2")}>{t("automation.fields.frequency")}</span>
						<div className="min-w-0 flex-1 space-y-3">
							<div className="flex h-9 w-fit items-center gap-0.5 rounded-md border border-border bg-surface p-[3px]">
								{(["cycle", "interval", "once"] as FreqMode[]).map((mode) => (
									<button
										key={mode}
										type="button"
										onClick={() => set("freqMode", mode)}
										className={cn(
											"h-[30px] min-w-[72px] rounded-[4px] px-3 text-sm transition-colors",
											form.freqMode === mode
												? "bg-accent font-semibold text-accent-fg"
												: "text-fg hover:bg-surface-2",
										)}
									>
										{t(`automation.freq.${mode}`)}
									</button>
								))}
							</div>
							{form.freqMode === "cycle" && (
								<div className="space-y-2">
									<div className="flex items-center gap-2">
										<div className="relative">
											<select
												className={cn(inputClass, "w-24 appearance-none pr-7")}
												value={form.cycleUnit}
												onChange={(e) => set("cycleUnit", e.target.value as CycleUnit)}
											>
												<option value="daily">{t("automation.cycle.daily")}</option>
												<option value="weekly">{t("automation.cycle.weekly")}</option>
												<option value="monthly">{t("automation.cycle.monthly")}</option>
												<option value="yearly">{t("automation.cycle.yearly")}</option>
											</select>
											<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
										</div>
										<input
											type="time"
											className={cn(inputClass, "w-32")}
											value={form.time}
											onChange={(e) => set("time", e.target.value)}
										/>
									</div>
									{form.cycleUnit === "weekly" && (
										<WeekdayChips value={form.weekdays} onChange={(next) => set("weekdays", next)} />
									)}
									{form.cycleUnit === "monthly" && (
										<div className="flex flex-wrap items-center gap-1">
											{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
												<button
													key={d}
													type="button"
													onClick={() =>
														set(
															"daysOfMonth",
															form.daysOfMonth.includes(d)
																? form.daysOfMonth.filter((x) => x !== d)
																: [...form.daysOfMonth, d].sort((a, b) => a - b),
														)
													}
													className={cn(
														"h-7 min-w-7 rounded-full border px-1.5 text-xs transition-colors",
														form.daysOfMonth.includes(d)
															? "border-accent bg-accent font-medium text-accent-fg"
															: "border-border text-muted hover:border-accent/40",
													)}
												>
													{t(`automation.dayOfMonth.${d}`)}
												</button>
											))}
										</div>
									)}
									{form.cycleUnit === "yearly" && (
										<div className="flex items-center gap-2">
											<div className="relative">
												<select
													className={cn(inputClass, "w-24 appearance-none pr-7")}
													value={form.yearlyMonth}
													onChange={(e) => set("yearlyMonth", Number(e.target.value))}
												>
													{Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
														<option key={mo} value={mo}>
															{t(`automation.months.${mo}`)}
														</option>
													))}
												</select>
												<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
											</div>
											<div className="relative">
												<select
													className={cn(inputClass, "w-24 appearance-none pr-7")}
													value={form.yearlyDay}
													onChange={(e) => set("yearlyDay", Number(e.target.value))}
												>
													{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
														<option key={d} value={d}>
															{t(`automation.dayOfMonth.${d}`)}
														</option>
													))}
												</select>
												<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
											</div>
										</div>
									)}
								</div>
							)}
							{form.freqMode === "interval" && (
								<div className="space-y-2">
									<div className="flex items-center gap-2">
										<span className="text-sm text-fg">{t("automation.fields.every")}</span>
										<input
											type="number"
											min={1}
											className={cn(inputClass, "w-20")}
											value={form.intervalN}
											onChange={(e) => set("intervalN", Number(e.target.value))}
										/>
										<div className="relative">
											<select
												className={cn(inputClass, "w-24 appearance-none pr-7")}
												value={form.intervalUnit}
												onChange={(e) => set("intervalUnit", e.target.value as "minute" | "hour")}
											>
												<option value="hour">{t("automation.units.hour")}</option>
												<option value="minute">{t("automation.units.minute")}</option>
											</select>
											<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
										</div>
									</div>
									{/* 星期限制(设计稿:每 3 小时 + 周一~周五;不选=每天) */}
									<div className="space-y-1">
										<WeekdayChips value={form.intervalWeekdays} onChange={(next) => set("intervalWeekdays", next)} />
										<p className="text-xs text-muted">{t("automation.fields.intervalDaysHint")}</p>
									</div>
								</div>
							)}
							{form.freqMode === "once" && (
								/* 单次(设计稿):日期选取器(附星期)+ 时间输入 */
								<div className="flex items-center gap-2">
									<DatePicker
										value={form.onceAt ? form.onceAt.slice(0, 10) : ""}
										showWeekday
										onChange={(d) => set("onceAt", d ? `${d}T${form.onceAt.includes("T") ? form.onceAt.slice(11, 16) || "00:00" : "00:00"}` : "")}
										className="w-44"
									/>
									<input
										type="time"
										className={cn(inputClass, "w-32")}
										value={form.onceAt.includes("T") ? form.onceAt.slice(11, 16) : ""}
										onChange={(e) =>
											set("onceAt", form.onceAt ? `${form.onceAt.slice(0, 10)}T${e.target.value || "00:00"}` : form.onceAt)
										}
									/>
								</div>
							)}
							{form.freqMode === "cron" && (
								<input
									className={cn(inputClass, "font-mono")}
									value={form.cronExpr}
									onChange={(e) => set("cronExpr", e.target.value)}
									placeholder="0 9 * * 1-5"
								/>
							)}
						</div>
					</div>
					{/* 生效日期区间(单次模式隐藏):双日期选取器(设计稿 494x36) */}
					{form.freqMode !== "once" && (
						<div className="flex items-center gap-2.5">
							<span className={formRowLabel}>{t("automation.fields.dateRange")}</span>
							<div className="flex flex-1 items-center gap-1.5">
								<DatePicker
									value={form.dateStart}
									placeholder={t("automation.fields.dateStart")}
									onChange={(v) => set("dateStart", v)}
									className="flex-1"
								/>
								<span className="shrink-0 text-muted">-</span>
								<DatePicker
									value={form.dateEnd}
									placeholder={t("automation.fields.dateEnd")}
									onChange={(v) => set("dateEnd", v)}
									className="flex-1"
								/>
							</div>
						</div>
					)}
					{/* 分隔线(设计稿 y=648) */}
					<div className="-mx-6 border-t border-border" />
					{/* 到点要发给 Agent 的消息 */}
					<div className="pt-1">
						<FieldLabel required>{t("automation.fields.prompt")}</FieldLabel>
						<textarea
							className={cn(inputClass, "h-[88px] resize-none py-2")}
							value={form.prompt}
							onChange={(e) => set("prompt", e.target.value)}
							placeholder={t("automation.fields.promptPlaceholder")}
						/>
					</div>
					{/* 高级设置三列:运行 / 并发 / 超时 */}
					<div className="grid grid-cols-3 gap-3">
						<div>
							<FieldLabel>{t("automation.fields.run")}</FieldLabel>
							<div className="relative">
								<select
									className={cn(inputClass, "appearance-none pr-7")}
									value={form.runTarget}
									onChange={(e) => set("runTarget", e.target.value as "pinned" | "new")}
								>
									<option value="pinned">{t("automation.runTarget.pinned")}</option>
									<option value="new">{t("automation.runTarget.new")}</option>
								</select>
								<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
							</div>
							{!isCurrentProject && form.runTarget === "pinned" && (
								<p className="mt-1 text-xs leading-4 text-muted">{t("automation.fields.pinHint")}</p>
							)}
						</div>
						<div>
							<FieldLabel>{t("automation.fields.concurrency")}</FieldLabel>
							<div className="relative">
								<select
									className={cn(inputClass, "appearance-none pr-7")}
									value={form.concurrency}
									onChange={(e) => set("concurrency", e.target.value as FormState["concurrency"])}
								>
									<option value="skip">{t("automation.concurrency.skip")}</option>
									<option value="queue">{t("automation.concurrency.queue")}</option>
									<option value="preempt">{t("automation.concurrency.preempt")}</option>
								</select>
								<ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
							</div>
						</div>
						<div>
							<FieldLabel>{t("automation.fields.timeout")}</FieldLabel>
							<div className="relative">
								<input
									type="number"
									min={0}
									className={cn(inputClass, "pr-8")}
									value={form.timeoutMinutes}
									onChange={(e) => set("timeoutMinutes", Number(e.target.value))}
								/>
								<span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">
									{t("automation.units.minute")}
								</span>
							</div>
						</div>
					</div>
					{error && <p className="text-xs text-danger">{error}</p>}
				</div>
				{/* Footer:左=已启用复选(18px 蓝框), 右=取消/保存(80x36 r6) */}
				<div className="flex items-center border-t border-border px-6 py-4">
					<label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
						<input
							type="checkbox"
							checked={form.enabled}
							onChange={(e) => set("enabled", e.target.checked)}
							className="h-[18px] w-[18px] accent-[var(--accent)]"
						/>
						{t("automation.fields.enabled")}
					</label>
					<div className="ml-auto flex gap-3">
						<button
							type="button"
							onClick={onClose}
							className="h-9 w-20 rounded-md bg-surface-2 text-sm text-fg transition-colors hover:opacity-90"
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={saving}
							onClick={() => void handleSave()}
							className="flex h-9 w-20 items-center justify-center gap-1.5 rounded-md bg-accent text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
							{t("common.save")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
