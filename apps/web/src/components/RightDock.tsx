import { useTranslation } from "react-i18next";
import { FolderOpen, Bot } from "lucide-react";
import FileExplorer from "@/views/FileExplorer";
import CodegenPanel from "@/views/CodegenPanel";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";

type RightDockTab = "files" | "codegen";

/**
 * The right-hand dock: workspace file browser + codegen pipeline panel,
 * switched by a top tab bar. Scoped to the active workspace — children
 * refetch/reset when `workspace` changes.
 * 历史 / 时间线 / 执行状态 / 回放 已上移到对话页顶部 tab 栏 (见 ChatView)。
 */
export default function RightDock({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tab, setTab] = usePersistedState<RightDockTab>("right-dock-tab", "files");

	const tabs: Array<{ key: RightDockTab; label: string; icon: typeof FolderOpen }> = [
		{ key: "files", label: t("files.title"), icon: FolderOpen },
		{ key: "codegen", label: t("codegen.title"), icon: Bot },
	];

	return (
		<div className="flex h-full flex-col border-l border-border bg-surface">
			{/* Tab bar — 与对话页顶栏同高，右侧留白避开悬浮的 dock 开关按钮。 */}
			<div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 pr-24">
				{tabs.map(({ key, label, icon: Icon }) => (
					<button
						key={key}
						type="button"
						onClick={() => setTab(key)}
						className={cn(
							"flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
							tab === key ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
						)}
					>
						<Icon className="h-3.5 w-3.5" />
						<span>{label}</span>
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "files" ? <FileExplorer workspace={workspace} /> : <CodegenPanel workspace={workspace} />}
			</div>
		</div>
	);
}
