/**
 * /replay — lightweight bilingual copy (zh/en), ported from dsh-replay2 i18n.js.
 * Framework-free: reads <html lang> / navigator at use time.
 */

export const NS = "dsh-replay2";

export const DICT_ZH: Record<string, string> = {
	tab: "回放新版",
	"view.title": "任务阶段回放",
	"view.empty.title": "当前任务暂无回放摘要",
	"view.empty.hint": "在会话目录放置 schema 2.0 的 replay-summary.json（可含 artifacts/）后刷新即可回放",
	"view.empty.timeline": "暂无可回放过程",
	"view.empty.onlyJson": "摘要文件存在但没有可回放内容",
	"view.error.load": "回放摘要加载失败",
	"view.error.corrupt": "replay-summary.json 无法解析",
	"view.loading": "正在加载回放摘要…",
	"view.legend": "✓ 已完成  ● 当前  ○ 未播放",
	"view.totalDuration": "总耗时",
	"view.currentRun": "执行轮次",
	"view.over": "回放完成",
	"task.result.completed": "任务完成",
	"task.result.failed": "任务失败",
	"task.result.running": "进行中",
	"phase.done": "已完成",
	"phase.current": "当前阶段",
	"phase.pending": "未播放",
	"phase.empty": "无执行轮次",
	"panel.steps": "执行过程",
	"panel.artifacts": "阶段产出",
	"panel.metrics": "数据结果",
	"panel.artifacts.empty": "暂无阶段产出",
	"panel.metrics.empty": "暂无统计数据",
	"panel.metrics.wait": "本轮执行完成后显示数据结果",
	"panel.metrics.more": "等",
	"run.type.rollback": "阶段回退",
	"run.type.reentry": "重新进入",
	"step.done": "已完成",
	"step.running": "执行中",
	"step.pending": "待执行",
	"step.failed": "失败",
	"step.confirmed": "已确认",
	"step.inputs": "输入",
	"step.calls": "调用",
	"step.outputs": "输出",
	"step.tags": "输入/调用",
	"step.noDetail": "本步骤未记录详情",
	"step.expand": "查看输入/调用/输出",
	"step.collapse": "收起",
	"control.play": "播放",
	"control.pause": "暂停",
	"control.restart": "重新播放",
	"control.prev": "上一阶段",
	"control.next": "下一阶段",
	speed: "倍速",
	"status.step": "步骤",
	"status.of": "/",
	"artifact.open": "打开",
	"artifact.download": "下载",
	"artifact.back": "← 返回",
	"artifact.noFile": "该产物未关联文件，或文件已不存在 / 被移动",
	"artifact.dir": "目录",
	"artifact.big": "文件较大，仅预览前 1.5MB，可下载完整文件",
	"artifact.notPreviewable": "该类型暂不支持内嵌预览，请使用上方「打开 / 下载」",
	"artifact.loadFailed": "产物读取失败",
	"modal.close": "关闭",
	"status.over": "全部阶段播放完成",
};

export const DICT_EN: Record<string, string> = {
	tab: "Replay",
	"view.title": "Task stage replay",
	"view.empty.title": "No replay summary for this task",
	"view.empty.hint":
		"Place a schema-2.0 replay-summary.json (optionally with artifacts/) into the conversation directory and refresh",
	"view.empty.timeline": "Nothing to replay",
	"view.empty.onlyJson": "Summary exists but has no replayable content",
	"view.error.load": "Failed to load replay summary",
	"view.error.corrupt": "replay-summary.json is not parseable",
	"view.loading": "Loading replay summary…",
	"view.legend": "✓ done  ● current  ○ pending",
	"view.totalDuration": "Total",
	"view.currentRun": "Round",
	"view.over": "Replay finished",
	"task.result.completed": "Completed",
	"task.result.failed": "Failed",
	"task.result.running": "Running",
	"phase.done": "Done",
	"phase.current": "Current",
	"phase.pending": "Pending",
	"phase.empty": "No round",
	"panel.steps": "Execution",
	"panel.artifacts": "Artifacts",
	"panel.metrics": "Metrics",
	"panel.artifacts.empty": "No artifacts for this round yet",
	"panel.metrics.empty": "No metrics for this round",
	"panel.metrics.wait": "Data results appear after this round finishes",
	"panel.metrics.more": "more",
	"run.type.rollback": "Rollback",
	"run.type.reentry": "Re-enter",
	"step.done": "Done",
	"step.running": "Running",
	"step.pending": "Pending",
	"step.failed": "Failed",
	"step.confirmed": "Confirmed",
	"step.inputs": "Inputs",
	"step.calls": "Calls",
	"step.outputs": "Outputs",
	"step.tags": "Tags",
	"step.noDetail": "No detail recorded for this step",
	"step.expand": "Show inputs/calls/outputs",
	"step.collapse": "Collapse",
	"control.play": "Play",
	"control.pause": "Pause",
	"control.restart": "Restart",
	"control.prev": "Previous",
	"control.next": "Next",
	speed: "Speed",
	"status.step": "Step",
	"status.of": "/",
	"artifact.open": "Open",
	"artifact.download": "Download",
	"artifact.back": "← Back",
	"artifact.noFile": "No file is linked, or it no longer exists / was moved",
	"artifact.dir": "Directory",
	"artifact.big": "Large file — previewing the first 1.5MB only; download for full content",
	"artifact.notPreviewable": "Inline preview is not supported — use Open / Download above",
	"artifact.loadFailed": "Failed to read artifact",
	"modal.close": "Close",
	"status.over": "All rounds finished",
};

export type ReplayLang = "zh" | "en";

/** Current UI language ('zh' | 'en'); falls back on navigator / html lang. */
export function pickLang(): ReplayLang {
	try {
		const htmlLang = document.documentElement?.lang;
		if (typeof htmlLang === "string" && htmlLang.startsWith("zh")) return "zh";
		if (typeof htmlLang === "string" && htmlLang.startsWith("en")) return "en";
	} catch {
		/* no DOM */
	}
	try {
		const nav = navigator?.language ?? "";
		if (nav.startsWith("zh")) return "zh";
	} catch {
		/* no navigator */
	}
	return "zh";
}

/** Translate one key with optional {param} interpolation. */
export function translate(key: string, params?: Record<string, unknown>): string {
	const lang = pickLang();
	const dict = lang === "en" ? DICT_EN : DICT_ZH;
	let text = dict[key] ?? DICT_EN[key] ?? key;
	if (params !== undefined) {
		for (const [name, value] of Object.entries(params)) {
			text = text.split(`{${name}}`).join(String(value));
		}
	}
	return text;
}

/** Bound translator (stable identity per call-site convenience). */
export function t(key: string, params?: Record<string, unknown>): string {
	return translate(key, params);
}
