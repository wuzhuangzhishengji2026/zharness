import { clsx } from "clsx";

export type PersonaPhase = "offline" | "idle" | "thinking" | "speaking" | "tool";

const PHASE_GLOW: Record<PersonaPhase, string> = {
	offline: "shadow-[0_0_18px_rgba(100,116,139,0.3)]",
	idle: "shadow-[0_0_18px_rgba(96,165,250,0.3)]",
	thinking: "shadow-[0_0_24px_rgba(167,139,250,0.5)] animate-pulse",
	speaking: "shadow-[0_0_24px_rgba(52,211,153,0.45)]",
	tool: "shadow-[0_0_24px_rgba(251,146,60,0.5)]",
};

const PHASE_RING: Record<PersonaPhase, string> = {
	offline: "from-slate-500/60 to-slate-700/60",
	idle: "from-sky-500/70 to-blue-600/70",
	thinking: "from-violet-500/80 to-fuchsia-500/70",
	speaking: "from-emerald-400/80 to-teal-500/70",
	tool: "from-amber-400/80 to-orange-500/70",
};

/**
 * Agent avatar — a gradient orb with the persona's first character.
 * Glow color and animation encode the live phase (thinking / speaking /
 * tool-using), giving the agent a "presence" inside the existing layout.
 */
export function PersonaAvatar({
	name,
	phase,
	size = 40,
	className,
}: {
	name: string;
	phase: PersonaPhase;
	size?: number;
	className?: string;
}) {
	const initial = name.slice(0, 1) || "E";
	return (
		<div
			className={clsx(
				"relative flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br p-[2px]",
				PHASE_RING[phase],
				PHASE_GLOW[phase],
				className,
			)}
			style={{ width: size, height: size }}
		>
			<div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-slate-800 to-slate-900">
				<span
					className="bg-gradient-to-br from-sky-200 to-violet-300 bg-clip-text font-serif font-bold text-transparent"
					style={{ fontSize: size * 0.42 }}
				>
					{initial}
				</span>
			</div>
		</div>
	);
}
