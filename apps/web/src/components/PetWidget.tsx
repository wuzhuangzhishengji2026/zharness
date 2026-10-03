import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gift, X, Utensils, Gamepad2, Trash2, Pencil, Sparkles } from "lucide-react";
import {
	fetchPetsState,
	hatchPetRpc,
	interactPetRpc,
	renamePetRpc,
	carryPetRpc,
	releasePetRpc,
	subscribePetsChanges,
} from "@/lib/pets";
import type { RpcHatchResult, RpcPet, RpcPetsState } from "@/lib/types";
import { ConfirmDialog } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * 浮动宠物挂件（宠物插件 pets 内置扩展的 GUI 面）。
 *
 * 右下角浮动小宠物（主动式助手的左侧，bottom-6 right-20）：没有宠物时
 * 是一只礼盒，点击开盲盒；有宠物后展示携带中的宠物，点开面板可以喂食、
 * 玩耍、切换携带、改名与放生。
 *
 * 盲盒按稀有度加权抽取（N 60% / R 25% / SR 12% / SSR 3%，闪光 4%），
 * 开盒有摇盒 → 揭晓的两段动画，SSR 金光爆闪。
 */

/** 稀有度视觉（星标色与 CSS 光效色，与扩展侧 RARITY_META 一致）。 */
const RARITY_VISUAL: Record<string, { stars: string; color: string }> = {
	N: { stars: "★", color: "#8a8f99" },
	R: { stars: "★★", color: "#22a05c" },
	SR: { stars: "★★★", color: "#9a5ce0" },
	SSR: { stars: "★★★★", color: "#e8a013" },
};

type Phase = "idle" | "shaking" | "revealed";

function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
	return (
		<div className="flex items-center gap-2 text-[11px] text-muted">
			<span className="w-8 shrink-0">{label}</span>
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
				<div
					className="h-full rounded-full transition-all"
					style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
				/>
			</div>
			<span className="w-8 shrink-0 text-right font-mono">{value}</span>
		</div>
	);
}

export function PetWidget({ workspace, sidecarReady }: { workspace: string | null; sidecarReady: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<RpcPetsState | null>(null);
	const [phase, setPhase] = useState<Phase>("idle");
	const [hatchResult, setHatchResult] = useState<RpcHatchResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [hint, setHint] = useState("");
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [releaseTarget, setReleaseTarget] = useState<RpcPet | null>(null);
	const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		setState(await fetchPetsState());
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		void refresh();
	}, [sidecarReady, workspace, refresh]);

	useEffect(() => {
		if (!sidecarReady) return;
		return subscribePetsChanges(() => void refresh());
	}, [sidecarReady, refresh]);

	useEffect(() => () => {
		if (shakeTimer.current) clearTimeout(shakeTimer.current);
	}, []);

	const handleHatch = useCallback(async () => {
		if (busy || phase !== "idle") return;
		setBusy(true);
		setHint("");
		setPhase("shaking");
		try {
			const result = await hatchPetRpc();
			// 最短摇盒时长，保证动画完整（RPC 通常几十 ms 就返回）。
			shakeTimer.current = setTimeout(() => {
				setHatchResult(result);
				setPhase("revealed");
				setBusy(false);
				void refresh();
			}, 1500);
		} catch (e) {
			setPhase("idle");
			setBusy(false);
			setHint(e instanceof Error ? e.message : String(e));
		}
	}, [busy, phase, refresh]);

	const closeReveal = useCallback(() => {
		setPhase("idle");
		setHatchResult(null);
	}, []);

	const handleInteract = useCallback(
		async (action: "feed" | "play", petId: string) => {
			setHint("");
			const result = await interactPetRpc(action, petId);
			if (!result?.pet) return;
			if (!result.effected) {
				setHint(t("pets.doneToday"));
			}
			void refresh();
		},
		[refresh, t],
	);

	const handleCarry = useCallback(
		async (petId: string) => {
			await carryPetRpc(petId);
			void refresh();
		},
		[refresh],
	);

	const handleRelease = useCallback(async () => {
		if (!releaseTarget) return;
		await releasePetRpc(releaseTarget.id);
		setReleaseTarget(null);
		void refresh();
	}, [releaseTarget, refresh]);

	const handleRename = useCallback(async () => {
		if (!renaming?.name.trim()) {
			setRenaming(null);
			return;
		}
		await renamePetRpc(renaming.id, renaming.name.trim());
		setRenaming(null);
		void refresh();
	}, [renaming, refresh]);

	const active = state?.activePetView ?? null;
	const pets = state?.pets ?? [];
	const todayIso = new Date().toISOString().slice(0, 10);
	const fedToday = active ? active.pet.lastFedAt?.slice(0, 10) === todayIso : false;
	const playedToday = active ? active.pet.lastPlayedAt?.slice(0, 10) === todayIso : false;

	return (
		<>
			{/* 折叠态：圆形按钮（携带宠物 emoji / 无宠物礼盒） */}
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title={t("pets.title")}
				className="fixed bottom-6 right-20 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface shadow-lg transition-transform hover:scale-105"
			>
				{active ? (
					<span className={cn("text-xl", active.pet.shiny && "pet-shiny-glow rounded-full")}>{active.speciesEmoji}</span>
				) : (
					<Gift className="h-5 w-5 text-accent" />
				)}
			</button>

			{/* 展开态：宠物面板 */}
			{open && (
				<div className="fixed bottom-20 right-20 z-40 flex max-h-[70vh] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
					<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
						<div className="flex items-center gap-2 text-sm font-semibold text-fg">
							{t("pets.title")}
							{state && (
								<span className="text-[11px] font-normal text-muted">
									{t("pets.totalHatched", { count: state.totalHatched })}
								</span>
							)}
						</div>
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="rounded p-1 text-muted transition-colors hover:text-fg"
						>
							<X className="h-4 w-4" />
						</button>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
						{hint && (
							<p className="mb-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-muted">{hint}</p>
						)}

						{phase === "shaking" && (
							<div className="flex flex-col items-center gap-3 py-10">
								<Gift className="blindbox-shake h-16 w-16 text-accent" />
								<p className="text-xs text-muted">{t("pets.hatching")}</p>
							</div>
						)}

						{phase === "revealed" && hatchResult && (
							<div className="pet-pop flex flex-col items-center gap-2 py-6 text-center">
								<div
									className="flex h-24 w-24 items-center justify-center rounded-2xl border-2"
									style={{
										borderColor: RARITY_VISUAL[hatchResult.draw.rarity]?.color,
										boxShadow:
											hatchResult.draw.rarity === "SSR"
												? "0 0 24px 4px rgba(232,160,19,0.55)"
												: `0 0 16px 2px ${RARITY_VISUAL[hatchResult.draw.rarity]?.color}55`,
										background: "var(--surface-2)",
									}}
								>
									<span className={cn("text-5xl", hatchResult.draw.shiny && "pet-shiny-glow rounded-2xl")}>
										{hatchResult.draw.speciesName ? speciesEmojiById(hatchResult.draw.speciesId) ?? "🐾" : "🐾"}
									</span>
								</div>
								<div className="flex items-center gap-1.5 text-sm font-semibold text-fg">
									{hatchResult.draw.speciesName}
									<span style={{ color: RARITY_VISUAL[hatchResult.draw.rarity]?.color }}>
										{RARITY_VISUAL[hatchResult.draw.rarity]?.stars}
									</span>
									{hatchResult.draw.shiny && (
										<span className="flex items-center gap-0.5 text-xs text-warning">
											<Sparkles className="h-3 w-3" />
											{t("pets.shiny")}
										</span>
									)}
								</div>
								<p className="text-xs text-muted">
									{hatchResult.overflow ? t("pets.overflow") : t("pets.newPet")}
								</p>
								<button
									type="button"
									onClick={closeReveal}
									className="mt-2 rounded-lg bg-accent px-4 py-1.5 text-xs text-accent-fg transition-opacity hover:opacity-90"
								>
									{t("common.ok")}
								</button>
							</div>
						)}

						{phase === "idle" && (
							<>
								{active ? (
									<div className="rounded-xl border border-border bg-surface-2/50 p-3">
										<div className="flex items-start gap-3">
											<div className="flex flex-col items-center gap-1">
												<span className={cn("pet-float text-4xl", active.pet.shiny && "pet-shiny-glow rounded-xl")}>
													{active.speciesEmoji}
												</span>
												<span className="text-[10px]" style={{ color: RARITY_VISUAL[active.pet.rarity]?.color }}>
													{RARITY_VISUAL[active.pet.rarity]?.stars}
													{active.pet.shiny ? " ✨" : ""}
												</span>
											</div>
											<div className="min-w-0 flex-1">
												{renaming?.id === active.pet.id ? (
													<input
														autoFocus
														value={renaming.name}
														onChange={(e) => setRenaming({ id: active.pet.id, name: e.target.value })}
														onKeyDown={(e) => {
															if (e.key === "Enter") void handleRename();
															if (e.key === "Escape") setRenaming(null);
														}}
														onBlur={() => void handleRename()}
														className="h-7 w-full rounded border border-border bg-surface px-2 text-sm text-fg focus:outline-none"
													/>
												) : (
													<div className="flex items-center gap-1">
														<span className="truncate text-sm font-semibold text-fg">{active.pet.name}</span>
														<Pencil
															className="h-3 w-3 shrink-0 cursor-pointer text-muted hover:text-accent"
															onClick={() => setRenaming({ id: active.pet.id, name: active.pet.name })}
														/>
													</div>
												)}
												<p className="mt-0.5 text-[11px] text-muted">
													{active.speciesName} · {active.personalityName}
												</p>
												<p className="mt-1 text-[11px] italic leading-relaxed text-muted/90">「{active.catchphrase}」</p>
											</div>
										</div>
										<div className="mt-2.5 space-y-1.5">
											<StatBar label={t("pets.mood")} value={active.pet.mood} color="#22a05c" />
											<StatBar label={t("pets.energy")} value={active.pet.energy} color="#0a84ff" />
										</div>
										<div className="mt-3 flex items-center gap-2">
											<button
												type="button"
												disabled={fedToday}
												onClick={() => void handleInteract("feed", active.pet.id)}
												className={cn(
													"flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors",
													fedToday
														? "border-border text-muted/50"
														: "border-border text-fg hover:border-accent/60 hover:text-accent",
												)}
											>
												<Utensils className="h-3.5 w-3.5" />
												{t("pets.feed")}
											</button>
											<button
												type="button"
												disabled={playedToday}
												onClick={() => void handleInteract("play", active.pet.id)}
												className={cn(
													"flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors",
													playedToday
														? "border-border text-muted/50"
														: "border-border text-fg hover:border-accent/60 hover:text-accent",
												)}
											>
												<Gamepad2 className="h-3.5 w-3.5" />
												{t("pets.play")}
											</button>
										</div>
									</div>
								) : (
									<p className="py-6 text-center text-xs text-muted">{t("pets.empty")}</p>
								)}

								<button
									type="button"
									disabled={busy}
									onClick={() => void handleHatch()}
									className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
								>
									<Gift className="h-4 w-4" />
									{t("pets.hatch")}
									<span className="text-[10px] text-muted">N60% · R25% · SR12% · SSR3%</span>
								</button>

								{pets.length > 0 && (
									<div className="mt-3">
										<div className="mb-1.5 text-[11px] font-medium text-muted">
											{t("pets.collection", { count: pets.length })}
										</div>
										<div className="space-y-1">
											{pets.map((pet) => {
												const isCarried = pet.id === state?.activePetId;
												return (
													<div
														key={pet.id}
														className={cn(
															"group flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
															isCarried ? "border-accent/50 bg-accent/5" : "border-border hover:border-muted/40",
														)}
													>
														<button
															type="button"
															className="flex min-w-0 flex-1 items-center gap-2 text-left"
															onClick={() => void handleCarry(pet.id)}
															title={t("pets.carry")}
														>
															<span className={cn("text-lg", pet.shiny && "pet-shiny-glow rounded-md")}>{speciesEmojiById(pet.speciesId) ?? "🐾"}</span>
															<span className="min-w-0 flex-1 truncate text-xs text-fg">{pet.name}</span>
															<span className="shrink-0 text-[10px]" style={{ color: RARITY_VISUAL[pet.rarity]?.color }}>
																{RARITY_VISUAL[pet.rarity]?.stars}
															</span>
															{isCarried && (
																<span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
																	{t("pets.carrying")}
																</span>
															)}
														</button>
														<Trash2
															className="h-3.5 w-3.5 shrink-0 cursor-pointer text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
															onClick={() => setReleaseTarget(pet)}
														/>
													</div>
												);
											})}
										</div>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}

			<ConfirmDialog
				open={releaseTarget !== null}
				onClose={() => setReleaseTarget(null)}
				onConfirm={() => void handleRelease()}
				title={t("pets.releaseTitle", { name: releaseTarget?.name ?? "" })}
				description={t("pets.releaseHint")}
				confirmText={t("pets.release")}
			/>
		</>
	);
}

/** 种族 id → emoji（GUI 侧轻量映射，与扩展图鉴一致；缺省 🐾）。 */
const SPECIES_EMOJI: Record<string, string> = {
	"cat-calico": "🐱",
	"dog-shiba": "🐶",
	hamster: "🐹",
	chick: "🐤",
	rabbit: "🐰",
	fox: "🦊",
	panda: "🐼",
	penguin: "🐧",
	koala: "🐨",
	frog: "🐸",
	unicorn: "🦄",
	dragon: "🐲",
	phoenix: "🔥",
	owl: "🦉",
	axolotl: "🦎",
	whale: "🐳",
	"cat-duke": "😺",
	"corgi-king": "🐕",
};

function speciesEmojiById(speciesId: string): string | undefined {
	return SPECIES_EMOJI[speciesId];
}
