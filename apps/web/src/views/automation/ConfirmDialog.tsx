import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** r30 确认弹窗(暂停/恢复/删除,高保真 22 画板;自 AutomationView 抽出共用)。 */
export function ConfirmDialog({
	kind,
	taskName,
	onClose,
	onConfirm,
}: {
	kind: "pause" | "resume" | "delete" | null;
	taskName: string;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation();
	if (!kind) return null;
	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
			<div
				className="w-[520px] rounded-[30px] bg-surface p-[30px] shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<h3 className="text-xl font-semibold text-fg">{t(`automation.confirm.${kind}.title`)}</h3>
				<p className="mt-4 text-lg leading-relaxed text-fg">
					{t(`automation.confirm.${kind}.message`, { name: taskName })}
				</p>
				<div className="mt-8 flex justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						className="h-9 w-20 rounded-md bg-surface-2 text-sm text-fg transition-colors hover:opacity-90"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className={cn(
							"h-9 w-20 rounded-md text-sm font-semibold text-white transition-opacity hover:opacity-90",
							kind === "delete" ? "bg-danger" : "bg-accent",
						)}
					>
						{t("common.confirm")}
					</button>
				</div>
			</div>
		</div>
	);
}
