/**
 * 决定回放视图该播哪个会话（对话页「回放」tab 的数据源选择）：
 *   1. 当前会话自己有回放摘要 → 播当前会话（tab 的自然语义：回放本次任务）
 *   2. 否则播工作区内最新的回放会话（归档 / 导入的回放，切到 tab 即直接播放）
 *   3. 工作区没有任何回放 → 回退 preferred（ReplayView 显示空态）
 *
 * sidecar 未就绪时不发命令（浏览器端命令会在 dev-bridge 503 静默丢失，
 * 干等超时后得到错误的空结果）；ready 翻 true 或 preferred 变化时重判。
 */

import { useEffect, useState } from "react";
import { fetchReplaySessions } from "./api";

export function useReplaySessionId(preferred: string | null, sidecarReady: boolean): string | null {
	const [resolved, setResolved] = useState<string | null>(preferred);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		fetchReplaySessions()
			.then((list) => {
				if (cancelled) return;
				if (preferred !== null && list.some((s) => s.sessionId === preferred)) {
					setResolved(preferred);
				} else {
					setResolved(list[0]?.sessionId ?? preferred);
				}
			})
			.catch(() => {
				if (!cancelled) setResolved(preferred);
			});
		return () => {
			cancelled = true;
		};
	}, [preferred, sidecarReady]);

	return resolved;
}
