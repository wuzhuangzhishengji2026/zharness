import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import ReplayView from "@/views/ReplayView";
import { historyTreeList } from "@/lib/transport";
import { fetchReplaySessions } from "@/views/replay/api";
import type { ReplaySessionEntry } from "@/views/replay/api";
import { cn } from "@/lib/utils";
import type { LayoutOutletContext } from "@/components/Layout";
import type { RpcHistoryTreeNode } from "@/lib/types";

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

function nodeLabel(node: RpcHistoryTreeNode): string {
	const title = node.name ?? node.snippet ?? "";
	return title.length > 0 ? `${title} · ${shortId(node.session_id)}` : shortId(node.session_id);
}

function replayLabel(entry: ReplaySessionEntry): string {
	const name = entry.taskName.length > 28 ? `${entry.taskName.slice(0, 28)}…` : entry.taskName;
	return name.length > 0 ? `🎬 ${name} · ${shortId(entry.sessionId)}` : `🎬 ${shortId(entry.sessionId)}`;
}

/** /replay 页面外壳 — ?session=<id> 驱动，顶部为标题 + 会话选择器。 */
export default function ReplayPage({
	currentSessionId,
	sidecarReady,
}: {
	currentSessionId: string | null;
	sidecarReady: boolean;
}) {
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const { t } = useTranslation();
	const [searchParams, setSearchParams] = useSearchParams();
	const [nodes, setNodes] = useState<RpcHistoryTreeNode[]>([]);
	const [replaySessions, setReplaySessions] = useState<ReplaySessionEntry[]>([]);

	useEffect(() => {
		// sidecar 未就绪时不发命令：浏览器端命令会在 dev-bridge 处 503 静默
		// 丢失,waitForResponse 干等到超时后 catch 置空,造成「回放时有时无」。
		// sidecarReady 翻 true(含崩溃重启/切换完成)后拉取;依赖变化自然重拉。
		if (!sidecarReady) return;
		let cancelled = false;
		historyTreeList()
			.then((list) => {
				if (!cancelled) setNodes(list);
			})
			.catch(() => {
				if (!cancelled) setNodes([]);
			});
		fetchReplaySessions()
			.then((list) => {
				if (!cancelled) setReplaySessions(list);
			})
			.catch(() => {
				if (!cancelled) setReplaySessions([]);
			});
		return () => {
			cancelled = true;
		};
	}, [sidecarReady]);

	const urlSession = searchParams.get("session");
	// 回放页的目的是看回放：默认选「有回放摘要的最新会话」（归档导入的会话
	// 不在历史树里），其次才是当前会话 / 历史树首条；URL 参数始终优先。
	const selected =
		urlSession !== null && urlSession.length > 0
			? urlSession
			: (replaySessions[0]?.sessionId ?? currentSessionId ?? nodes[0]?.session_id ?? null);

	const replayIds = new Set(replaySessions.map((s) => s.sessionId));
	const historyOnly = nodes.filter((n) => !replayIds.has(n.session_id));

	const onSelect = (sessionId: string) => {
		setSearchParams((prev) => {
			const next = new URLSearchParams(prev);
			next.set("session", sessionId);
			return next;
		});
	};

	return (
		<div className="flex h-full flex-col">
			<div
				data-tauri-drag-region
				className={cn(
					"h-11 shrink-0 transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			/>
			<div className="flex shrink-0 items-center justify-between gap-4 px-6 pb-3">
				<h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-fg">
					<span className="h-5 w-1 shrink-0 rounded-full bg-accent" />
					{t("layout.replay")}
				</h1>
				<select
					className="h-8 max-w-[360px] rounded-md border border-border bg-surface px-2 text-xs text-fg outline-none transition-colors hover:border-accent/60 focus:border-accent disabled:opacity-50"
					value={selected ?? ""}
					disabled={replaySessions.length === 0 && nodes.length === 0 && selected === null}
					onChange={(e) => onSelect(e.target.value)}
				>
					{selected === null && (
						<option value="" disabled>
							—
						</option>
					)}
					{selected !== null && !replayIds.has(selected) && !historyOnly.some((n) => n.session_id === selected) && (
						<option value={selected}>{shortId(selected)}</option>
					)}
					{replaySessions.map((s) => (
						<option key={s.sessionId} value={s.sessionId}>
							{replayLabel(s)}
						</option>
					))}
					{historyOnly.map((n) => (
						<option key={n.session_id} value={n.session_id}>
							{nodeLabel(n)}
						</option>
					))}
				</select>
			</div>
			<div className="min-h-0 flex-1">
				<ReplayView sessionId={selected} />
			</div>
		</div>
	);
}
