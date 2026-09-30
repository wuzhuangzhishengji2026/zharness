import { useEffect, useMemo, useState } from "react";
import { sendCommandAwait, subscribeEvents } from "@/lib/transport";
import { parseSoul, deriveAgentName, deriveAgentRole } from "@/persona/soul";
import { PersonaAvatar, type PersonaPhase } from "@/persona/PersonaAvatar";
import { cn } from "@/lib/utils";

interface PersonaData {
	soul: {
		path: string;
		content: string | null;
		uninitialized: boolean;
	};
	userProfile: { path: string; content: string } | null;
	memory: { path: string; content: string }[];
}

/**
 * Personified identity strip — embeds in the existing Layout's left sidebar.
 *
 * Subscribes to the event stream to drive the avatar phase (thinking /
 * speaking / tool) so the agent has live "presence" inside the existing
 * GUI. Identity details and user long-term memory live in SettingsView.
 */
export function PersonaCard({ online }: { online: boolean }) {
	const [persona, setPersona] = useState<PersonaData | null>(null);
	const [phase, setPhase] = useState<PersonaPhase>(online ? "idle" : "offline");

	// Load persona (SOUL.md) via the get_persona RPC command.
	useEffect(() => {
		if (!online) {
			setPhase("offline");
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait<PersonaData>({ type: "get_persona" }, 10000);
				if (cancelled) return;
				if (r.data) {
					setPersona(r.data);
					setPhase("idle");
				}
			} catch {
				/* sidecar not ready yet — keep idle */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [online]);

	// Drive the avatar phase from the live event stream.
	useEffect(() => {
		if (!online) return;
		let unsub: (() => void) | null = null;
		subscribeEvents((ev) => {
			const type = ev.type as string;
			switch (type) {
				case "AGENT_TURN_START":
					setPhase("thinking");
					break;
				case "AGENT_MESSAGE_START":
					setPhase("speaking");
					break;
				case "TOOL_EXECUTION_START":
					setPhase("tool");
					break;
				case "TOOL_EXECUTION_END":
				case "AGENT_MESSAGE_END":
					setPhase("speaking");
					break;
				case "AGENT_TURN_COMPLETED":
					setPhase("idle");
					break;
			}
		}).then((fn) => {
			unsub = fn;
		});
		return () => {
			unsub?.();
		};
	}, [online]);

	const agentName = useMemo(() => deriveAgentName(parseSoul(persona?.soul?.content ?? null)), [persona]);
	const agentRole = useMemo(() => deriveAgentRole(parseSoul(persona?.soul?.content ?? null)), [persona]);

	return (
		<div className="border-t border-border bg-gradient-to-b from-surface to-surface/60">
			<div className="flex items-center gap-3 p-3">
				<PersonaAvatar name={agentName} phase={phase} size={32} />
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-xs font-bold text-fg">{agentName}</div>
					{agentRole && (
						<div className="truncate font-mono text-[10px] text-muted">{agentRole}</div>
					)}
				</div>
			</div>
		</div>
	);
}
