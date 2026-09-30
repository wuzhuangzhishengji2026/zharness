import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { subscribeExtensionUIRequests, sendExtensionUIResponse } from "@/lib/transport";
import { Button, Modal } from "@/components/ui";
import type { RpcExtensionUIRequest } from "@/lib/types";

/**
 * Dialog for extension UI requests (confirm / input) bridged from the
 * sidecar over the RPC protocol — e.g. the codegen pipeline's confirm
 * points between stages.
 *
 * Requests carry a `_cwd` tag (added by the desktop bridge) so a window
 * only renders dialogs for its own active workspace. Responses are routed
 * through rpc_command → this window's active sidecar, which is why the
 * dialog is dismissed when the active workspace changes: a response sent
 * after switching would be delivered to the wrong sidecar. The stranded
 * request then times out on the sidecar, which falls back to headless
 * behavior (auto-approve / cancel) with a visible notify.
 */

type PendingRequest = RpcExtensionUIRequest & { _cwd?: string };

function requestMessage(req: PendingRequest): string {
	return "message" in req && typeof req.message === "string" ? req.message : "";
}

function requestPlaceholder(req: PendingRequest): string {
	return "placeholder" in req && typeof req.placeholder === "string" ? req.placeholder : "";
}

function requestTitle(req: PendingRequest): string {
	return "title" in req && typeof req.title === "string" ? req.title : "";
}

function requestTimeout(req: PendingRequest): number {
	return "timeout" in req && typeof req.timeout === "number" && req.timeout > 0 ? req.timeout : 300_000;
}

export function ExtensionUIDialog({ workspace }: { workspace: string | null }) {
	const { t } = useTranslation();
	const [pending, setPending] = useState<PendingRequest | null>(null);
	const [inputValue, setInputValue] = useState("");

	useEffect(() => {
		let cancelled = false;
		let unsub: (() => void) | null = null;
		(async () => {
			const fn = await subscribeExtensionUIRequests((request) => {
				const typed = request as PendingRequest;
				// Multi-window: only handle requests for this window's active
				// workspace. Untagged requests (browser dev bridge) always pass.
				if (typed._cwd && workspace && typed._cwd !== workspace) return;
				// Only confirm/input are interactive dialogs; other methods
				// (notify etc.) surface as CUSTOM_MESSAGE events elsewhere.
				if (typed.method !== "confirm" && typed.method !== "input") return;
				// Replace any pending request, cancelling it so the sidecar
				// doesn't sit through its full timeout.
				setPending((prev) => {
					if (prev) {
						void sendExtensionUIResponse({ type: "extension_ui_response", id: prev.id, cancelled: true }).catch(() => {});
					}
					return typed;
				});
				setInputValue("");
			});
			if (cancelled) {
				fn();
				return;
			}
			unsub = fn;
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, [workspace]);

	// Dismiss on workspace switch (see comment above) and on mount.
	useEffect(() => {
		setPending(null);
		setInputValue("");
	}, [workspace]);

	// Local mirror of the sidecar's request timeout: once it elapses the
	// sidecar has already resolved with its fallback (auto-approve/cancel,
	// announced via notify), so the dialog just goes away.
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => {
			setPending(null);
			setInputValue("");
		}, requestTimeout(pending));
		return () => clearTimeout(timer);
	}, [pending]);

	if (!pending) return null;

	if (pending.method === "input") {
		const submit = () => {
			void sendExtensionUIResponse({ type: "extension_ui_response", id: pending.id, value: inputValue }).catch(() => {});
			setPending(null);
			setInputValue("");
		};
		const cancel = () => {
			void sendExtensionUIResponse({ type: "extension_ui_response", id: pending.id, cancelled: true }).catch(() => {});
			setPending(null);
			setInputValue("");
		};
		return (
			<Modal
				open
				onClose={cancel}
				title={requestTitle(pending)}
				footer={
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={cancel}>
							{t("extensionUi.cancel")}
						</Button>
						<Button onClick={submit}>{t("extensionUi.submit")}</Button>
					</div>
				}
			>
				<p className="mb-3 text-sm text-muted">{t("extensionUi.hint")}</p>
				<input
					type="text"
					autoFocus
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					placeholder={requestPlaceholder(pending)}
					aria-label={t("extensionUi.inputLabel")}
					className="w-full rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
						if (e.key === "Escape") cancel();
					}}
				/>
			</Modal>
		);
	}

	// confirm (default)
	const confirm = (confirmed: boolean) => {
		void sendExtensionUIResponse({ type: "extension_ui_response", id: pending.id, confirmed }).catch(() => {});
		setPending(null);
	};
	return (
		<Modal
			open
			onClose={() => confirm(false)}
			title={requestTitle(pending)}
			footer={
				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={() => confirm(false)}>
						{t("extensionUi.cancel")}
					</Button>
					<Button onClick={() => confirm(true)}>{t("extensionUi.confirm")}</Button>
				</div>
			}
		>
			<p className="mb-2 text-sm text-muted">{t("extensionUi.hint")}</p>
			<p className="whitespace-pre-wrap font-mono text-sm text-fg">{requestMessage(pending)}</p>
		</Modal>
	);
}
