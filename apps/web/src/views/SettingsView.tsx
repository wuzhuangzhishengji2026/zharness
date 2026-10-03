import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation, useOutletContext } from "react-router-dom";
import { PageHeader, Card, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PixelSelect, PixelCombobox } from "@pxlkit/ui-kit";
import { Image as ImageIcon, Pencil } from "lucide-react";
import {
	fetchSkinState,
	applySkinRpc,
	addSkinRpc,
	removeSkinRpc,
	fetchSkinImage,
	renameSkinRpc,
	subscribeSkinChanges,
} from "@/lib/skins";
import type { RpcSkinState, RpcSkin } from "@/lib/types";
import {
	listProviders,
	setProviderApiKey,
	removeProviderApiKey,
	addCustomProvider,
	removeCustomProvider,
	fetchCustomProviderModels,
	type ProviderInfo,
} from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";
import { sendCommandAwait } from "@/lib/transport";
import { Key, Trash2, Eye, EyeOff, Plus, ArrowLeft, ArrowRight, Sparkles, X, Check, Layers, RefreshCw, Bot, Brain, MessageSquare, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseSoul, deriveAgentName, deriveAgentRole } from "@/persona/soul";
import type { LayoutOutletContext } from "@/components/Layout";
import {
	SUPPORTED_LANGUAGES,
	DEFAULT_LANGUAGE,
	setStoredLanguage,
	type AppLanguage,
} from "@/i18n";
import { useFontSize, type FontSize } from "@/lib/fontSize";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
			<span className="text-sm text-fg">{label}</span>
			<span className="text-sm text-muted">{children}</span>
		</div>
	);
}

function providerLabel(provider: { id: string; name?: string }): string {
	return provider.name ?? provider.id;
}

/**
 * A custom provider is one not in the built-in catalog. The Rust bridge tags
 * such entries with `name === id` (no friendly display name from
 * `dist/providers.json`). We use that as a robust signal for routing
 * `ProviderRow` to `removeCustomProvider` instead of `removeProviderApiKey`.
 */
function isCustomProvider(provider: { id: string; name?: string }): boolean {
	return (provider.name ?? provider.id) === provider.id;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({ value: level, label: level }));

function GeneralTab({ state }: { state: RpcSessionState | null }) {
	const { t, i18n } = useTranslation();
	const [thinkingLevel, setThinkingLevel] = useState<string>(state?.thinkingLevel ?? "off");
	const [fontSize, setFontSize] = useFontSize();
	const [language, setLanguage] = useState<AppLanguage>(
		(SUPPORTED_LANGUAGES.includes(i18n.language as AppLanguage) ? i18n.language : DEFAULT_LANGUAGE) as AppLanguage,
	);

	const handleThinkingChange = useCallback(async (level: string) => {
		setThinkingLevel(level);
		try {
			await sendCommandAwait({ type: "set_thinking_level", level: level as RpcSessionState["thinkingLevel"] });
		} catch (e) {
			console.error("[settings] set_thinking_level failed:", e);
		}
	}, []);

	const handleLanguageChange = useCallback((value: string) => {
		const lang = (SUPPORTED_LANGUAGES.includes(value as AppLanguage) ? value : DEFAULT_LANGUAGE) as AppLanguage;
		setLanguage(lang);
		setStoredLanguage(lang);
		void i18n.changeLanguage(lang);
	}, [i18n]);

	const languageOptions = SUPPORTED_LANGUAGES.map((lang) => ({
		value: lang,
		label: t(`language.${lang}`),
	}));

	return (
		<div className="space-y-6">
			<Card>
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.model")}</div>
				<Row label={t("settings.general.currentProvider")}>
					<span className="font-mono">{state?.model?.provider ?? "—"}</span>
				</Row>
				<Row label={t("settings.general.currentModel")}>
					<span className="font-mono">{state?.model?.id ?? "—"}</span>
				</Row>
				<Row label={t("settings.general.thinkingLevel")}>
					<div className="w-32">
						<PixelSelect
							value={thinkingLevel}
							options={THINKING_OPTIONS}
							onChange={handleThinkingChange}
							size="sm"
							tone="cyan"
						/>
					</div>
				</Row>
			</Card>

			<Card>
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.language")}</div>
				<Row label={t("settings.general.languageDescription")}>
					<div className="w-40">
						<PixelSelect
							value={language}
							options={languageOptions}
							onChange={handleLanguageChange}
							size="sm"
							tone="cyan"
						/>
					</div>
				</Row>
			</Card>

			<Card>
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.fontSize")}</div>
				<Row label={t("settings.general.fontSizeDescription")}>
					<div className="w-40">
						<PixelSelect
							value={fontSize}
							options={(["small", "standard", "large"] as FontSize[]).map((size) => ({
								value: size,
								label: t(`settings.general.fontSize${size === "small" ? "Small" : size === "standard" ? "Standard" : "Large"}`),
							}))}
							onChange={(value) => setFontSize(value as FontSize)}
							size="sm"
							tone="cyan"
						/>
					</div>
				</Row>
			</Card>

			<SkinCard />
		</div>
	);
}

/**
 * 皮肤管理卡片（换肤插件 skins 内置扩展的 GUI 面）：
 * 皮肤库网格（内置色板 + 自定义图片）、上传自定义图片、
 * 调节图片皮肤的遮罩浓度/模糊度、重命名与删除。
 * 应用动作走 lib/skins.ts（RPC + CSS 注入），卡片只做目录编排。
 */
function SkinCard() {
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSkinState | null>(null);
	/** 自定义图片皮肤的缩略图缓存（skinId → dataURL）。 */
	const [thumbs, setThumbs] = useState<Record<string, string>>({});
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	/** 重命名中的皮肤 id 与草稿。 */
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [pendingImageSkin, setPendingImageSkin] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		const next = await fetchSkinState();
		setState(next);
		// 预取自定义皮肤缩略图（跳过已有缓存）。
		const missing = next.skins.filter((s) => s.image && !(s.id in thumbs));
		if (missing.length > 0) {
			const entries = await Promise.all(
				missing.map(async (s) => [s.id, await fetchSkinImage(s.id)] as const),
			);
			setThumbs((prev) => {
				const merged = { ...prev };
				for (const [id, dataUrl] of entries) {
					if (dataUrl) merged[id] = dataUrl;
				}
				return merged;
			});
		}
	}, [thumbs]);

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => subscribeSkinChanges(() => void refresh()), [refresh]);

	const handleApply = useCallback(async (skinId: string) => {
		setError("");
		try {
			await applySkinRpc(skinId);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [refresh]);

	const handleUpload = useCallback(async (file: File) => {
		setUploading(true);
		setError("");
		try {
			if (file.size > 8 * 1024 * 1024) {
				throw new Error(t("settings.skin.tooLarge"));
			}
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error(t("settings.skin.readFailed")));
				reader.readAsDataURL(file);
			});
			await addSkinRpc(file.name.replace(/\.[^.]+$/, ""), dataUrl);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setUploading(false);
		}
	}, [refresh, t]);

	const handleAdjust = useCallback(
		async (skin: RpcSkin, dim?: number, blur?: number) => {
			try {
				await applySkinRpc(skin.id, { dim, blur });
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[refresh],
	);

	const handleRemove = useCallback(async (skin: RpcSkin) => {
		if (!confirm(t("settings.skin.confirmRemove", { name: skin.name }))) return;
		setError("");
		try {
			await removeSkinRpc(skin.id);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [refresh, t]);

	const handleRename = useCallback(async () => {
		if (!renaming?.name.trim()) {
			setRenaming(null);
			return;
		}
		try {
			await renameSkinRpc(renaming.id, renaming.name.trim());
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRenaming(null);
		}
	}, [renaming, refresh]);

	const activeSkin = state?.skins.find((s) => s.id === state.activeSkinId) ?? null;

	return (
		<Card>
			<div className="mb-2 flex items-center justify-between">
				<div className="text-sm font-medium text-fg">{t("settings.skin.title")}</div>
				<Button
					size="sm"
					tone="accent"
					variant="soft"
					loading={uploading}
					disabled={uploading}
					onClick={() => fileInputRef.current?.click()}
					title={t("settings.skin.uploadHint")}
				>
					{t("settings.skin.upload")}
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) void handleUpload(file);
					}}
				/>
			</div>
			<p className="mb-3 text-xs text-muted">{t("settings.skin.description")}</p>
			{error && (
				<p className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
			)}
			{!state ? (
				<p className="py-4 text-center text-xs text-muted">{t("plugins.loading")}</p>
			) : (
				<>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
						{state.skins.map((skin) => {
							const active = skin.id === state.activeSkinId;
							const thumb = skin.image ? thumbs[skin.id] : undefined;
							return (
								<button
									key={skin.id}
									type="button"
									onClick={() => void handleApply(skin.id)}
									title={skin.description}
									className={cn(
										"group relative overflow-hidden rounded-lg border text-left transition-all",
										active ? "border-accent ring-1 ring-accent/40" : "border-border hover:border-muted/50",
									)}
								>
									<div
										className="flex h-16 items-center justify-center"
										style={
											skin.image
												? thumb
													? { backgroundImage: `url(${thumb})`, backgroundSize: "cover", backgroundPosition: "center" }
													: { background: "linear-gradient(135deg, rgba(148,163,184,0.25), rgba(148,163,184,0.1))" }
												: {
														background: skin.colors
															? `linear-gradient(135deg, ${skin.colors.light["--bg"] ?? "#fff"} 0%, ${skin.colors.light["--surface-2"] ?? "#eee"} 55%, ${skin.colors.light["--accent"] ?? "#08f"} 100%)`
															: undefined,
														backgroundColor: skin.colors ? undefined : "var(--surface-2)",
													}
										}
									>
										{skin.image && !thumb && <ImageIcon className="h-5 w-5 text-muted" />}
									</div>
									{renaming?.id === skin.id ? (
										<div className="flex items-center gap-1 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
											<input
												autoFocus
												value={renaming.name}
												onChange={(e) => setRenaming({ id: skin.id, name: e.target.value })}
												onKeyDown={(e) => {
													if (e.key === "Enter") void handleRename();
													if (e.key === "Escape") setRenaming(null);
												}}
												className="h-6 w-full min-w-0 rounded border border-border bg-surface-2 px-1.5 text-xs text-fg focus:outline-none"
											/>
										</div>
									) : (
										<div className="flex items-center gap-1 px-2 py-1.5">
											<span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{skin.name}</span>
											{skin.kind === "custom" && (
												<span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
													<Pencil
														className="h-3 w-3 cursor-pointer text-muted hover:text-accent"
														onClick={(e) => {
															e.stopPropagation();
															setRenaming({ id: skin.id, name: skin.name });
														}}
													/>
													<Trash2
														className="h-3 w-3 cursor-pointer text-muted hover:text-danger"
														onClick={(e) => {
															e.stopPropagation();
															void handleRemove(skin);
														}}
													/>
												</span>
											)}
											{active && <Badge tone="success">{t("settings.skin.active")}</Badge>}
										</div>
									)}
								</button>
							);
						})}
					</div>
					{activeSkin?.image && (
						<div
							key={`${activeSkin.id}:${activeSkin.image.dim}:${activeSkin.image.blur}`}
							className="mt-4 space-y-2 rounded-lg border border-border bg-surface-2/50 px-3 py-3"
						>
							<div className="text-xs font-medium text-fg">{t("settings.skin.adjustTitle", { name: activeSkin.name })}</div>
							<label className="flex items-center gap-3 text-xs text-muted">
								<span className="w-16 shrink-0">{t("settings.skin.dim")}</span>
								<input
									type="range"
									min={0}
									max={90}
									step={5}
									defaultValue={Math.round((activeSkin.image.dim ?? 0.45) * 100)}
									onChange={() => setPendingImageSkin(activeSkin.id)}
								onPointerUp={(e) => {
									if (pendingImageSkin === activeSkin.id) {
										void handleAdjust(activeSkin, Number((e.target as HTMLInputElement).value) / 100);
										setPendingImageSkin(null);
									}
								}}
									className="h-1 flex-1 accent-[var(--accent)]"
								/>
							</label>
							<label className="flex items-center gap-3 text-xs text-muted">
								<span className="w-16 shrink-0">{t("settings.skin.blur")}</span>
								<input
									type="range"
									min={0}
									max={12}
									step={1}
									defaultValue={activeSkin.image.blur ?? 0}
									onChange={() => setPendingImageSkin(activeSkin.id)}
								onPointerUp={(e) => {
									if (pendingImageSkin === activeSkin.id) {
										void handleAdjust(activeSkin, undefined, Number((e.target as HTMLInputElement).value));
										setPendingImageSkin(null);
									}
								}}
									className="h-1 flex-1 accent-[var(--accent)]"
								/>
							</label>
							<p className="text-[10px] text-muted/70">{t("settings.skin.adjustHint")}</p>
						</div>
					)}
				</>
			)}
		</Card>
	);
}

function ProviderRow({ provider, onRefresh }: { provider: ProviderInfo; onRefresh: () => void }) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const handleSave = useCallback(async () => {
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(provider.id, keyValue.trim());
			setEditing(false);
			setKeyValue("");
			setShowKey(false);
			onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [keyValue, provider.id, onRefresh, t]);

	const handleRemove = useCallback(async () => {
		if (!confirm(t("settings.provider.confirmRemove", { label: providerLabel(provider) }))) return;
		try {
			if (isCustomProvider(provider)) {
				await removeCustomProvider(provider.id);
			} else {
				await removeProviderApiKey(provider.id);
			}
			onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [provider, onRefresh, t]);

	const label = providerLabel(provider);

	return (
		<div className="border-b border-border/60 py-3 last:border-0">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Key className={cn("h-4 w-4", provider.has_api_key ? "text-success" : "text-muted")} />
					<span className="text-sm font-medium text-fg">{label}</span>
					{provider.has_api_key ? (
						<Badge tone={provider.auth_type === "oauth" ? "accent" : "success"}>
							{provider.auth_type === "oauth" ? t("settings.provider.oauth") : t("settings.provider.apiKey")}
						</Badge>
					) : (
						<Badge tone="neutral">{t("settings.provider.notConfigured")}</Badge>
					)}
				</div>
				<div className="flex items-center gap-1">
					{!editing && provider.auth_type !== "oauth" && (
						<button
							onClick={() => setEditing(true)}
							className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={provider.has_api_key ? t("settings.provider.update") : t("settings.provider.configure")}
						>
							<RefreshCw className="h-3.5 w-3.5" />
						</button>
					)}
					{provider.has_api_key && provider.auth_type !== "oauth" && !editing && (
						<button
							onClick={handleRemove}
							className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-danger"
							title={t("settings.provider.remove")}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
			</div>
			{editing && (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							placeholder={t("settings.provider.enterKey", { label })}
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={() => { setEditing(false); setKeyValue(""); setShowKey(false); setError(""); }}>
							{t("settings.provider.cancel")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function AddProviderInline({
	available,
	onSaved,
	onCancel,
}: {
	available: ProviderInfo[];
	onSaved: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [selected, setSelected] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const providerOptions = available.map((p) => ({
		value: p.id,
		label: providerLabel(p),
	}));

	const selectedProvider = available.find((p) => p.id === selected);
	const label = selectedProvider ? providerLabel(selectedProvider) : "";

	const handleSave = useCallback(async () => {
		if (!selected) {
			setError(t("settings.provider.selectProvider"));
			return;
		}
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(selected, keyValue.trim());
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [selected, keyValue, onSaved, t]);

	return (
		<div className="border-b border-border/60 py-3">
			<div className="mb-2 text-xs font-medium text-fg">{t("settings.provider.addNew")}</div>
			<div className="flex items-center gap-2">
				<div className="flex-1">
					<PixelCombobox
						value={selected}
						options={providerOptions}
						onChange={(v) => { setSelected(v); setError(""); }}
						placeholder={t("settings.provider.selectProviderPlaceholder")}
						size="sm"
						emptyMessage={t("settings.provider.noMatch")}
					/>
				</div>
				{!selected && (
					<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
				)}
			</div>
			{selected && (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							placeholder={t("settings.provider.enterKey", { label })}
							autoFocus
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
					</div>
				</div>
			)}
		</div>
	);
}

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function AddCustomProviderForm({
	onSaved,
	onCancel,
}: {
	onSaved: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [api, setApi] = useState("openai-completions");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [fetchedModels, setFetchedModels] = useState<string[]>([]);
	const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
	const [fetchError, setFetchError] = useState(false);
	const [fetching, setFetching] = useState(false);
	const [manualModel, setManualModel] = useState("");
	const [contextWindow, setContextWindow] = useState("128000");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	// Anthropic endpoints authenticate with x-api-key, so the /models fetch
	// (Bearer-only) can never succeed there — hide it and let the user type
	// model ids manually instead of showing a scary failure.
	const supportsModelFetch = api !== "anthropic-messages";
	const apiOptions = [
		{ value: "openai-completions", label: t("settings.provider.custom.apiOpenAICompat") },
		{ value: "anthropic-messages", label: t("settings.provider.custom.apiAnthropic") },
		{ value: "openai-responses", label: t("settings.provider.custom.apiOpenAIResponses") },
	];

	const nameValid = name.length > 0 && NAME_REGEX.test(name);
	const urlValid = /^https?:\/\//.test(baseUrl);
	const canFetch = nameValid && urlValid && (apiKey.trim().length > 0 || true /* key optional for /models */);

	const handleFetch = useCallback(async () => {
		if (!urlValid) {
			setError(t("settings.provider.custom.urlInvalid"));
			return;
		}
		setFetching(true);
		setFetchError(false);
		setFetchedModels([]);
		try {
			const models = await fetchCustomProviderModels(baseUrl, apiKey.trim() || null);
			setFetchedModels(models.map((m) => m.id));
			if (models.length === 0) {
				setFetchError(true);
			}
		} catch {
			setFetchError(true);
		} finally {
			setFetching(false);
		}
	}, [baseUrl, apiKey, urlValid, t]);

	const toggleModel = useCallback((id: string) => {
		setSelectedModels((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const addManualModel = useCallback(() => {
		const trimmed = manualModel.trim();
		if (!trimmed) return;
		setSelectedModels((prev) => new Set(prev).add(trimmed));
		setFetchedModels((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
		setManualModel("");
	}, [manualModel]);

	const handleSave = useCallback(async () => {
		setError("");
		if (!nameValid) {
			setError(t("settings.provider.custom.nameInvalid"));
			return;
		}
		if (!urlValid) {
			setError(t("settings.provider.custom.urlInvalid"));
			return;
		}
		if (selectedModels.size === 0) {
			setError(t("settings.provider.custom.noModelsSelected"));
			return;
		}
		const contextWindowValue = Number.parseInt(contextWindow, 10);
		if (!Number.isFinite(contextWindowValue) || contextWindowValue <= 0) {
			setError(t("settings.provider.custom.contextWindowInvalid"));
			return;
		}
		setSaving(true);
		try {
			await addCustomProvider(
				name.trim(),
				baseUrl.trim(),
				apiKey.trim() || null,
				Array.from(selectedModels),
				contextWindowValue,
				api,
			);
			onSaved();
		} catch (e) {
			setError(t("settings.provider.custom.saveError", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setSaving(false);
		}
	}, [name, nameValid, baseUrl, urlValid, apiKey, selectedModels, contextWindow, api, onSaved, t]);

	return (
		<div className="border-b border-border/60 py-3">
			<div className="mb-2 text-xs font-medium text-fg">
				<Sparkles className="mr-1 inline h-3.5 w-3.5" />
				{t("settings.provider.custom.title")}
			</div>
			<p className="mb-3 font-mono text-[10px] text-muted">
				{t("settings.provider.custom.description")}
			</p>
			<div className="space-y-2">
				<div>
					<div className="flex items-center gap-2">
						<span className="w-16 shrink-0 font-mono text-[10px] text-muted">{t("settings.provider.custom.apiLabel")}</span>
						<div className="w-72">
							<PixelSelect value={api} options={apiOptions} onChange={(value) => setApi(value)} size="sm" tone="cyan" />
						</div>
					</div>
					<p className="mt-1 font-mono text-[10px] text-muted">{t("settings.provider.custom.apiHint")}</p>
				</div>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t("settings.provider.custom.namePlaceholder")}
					className="w-full rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
				<p className="font-mono text-[10px] text-muted">{t("settings.provider.custom.nameHint")}</p>
				<input
					type="text"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder={t("settings.provider.custom.urlPlaceholder")}
					className="w-full rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
				<div className="flex items-center gap-2">
					<input
						type={showKey ? "text" : "password"}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={t("settings.provider.custom.keyPlaceholder")}
						className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					<button
						onClick={() => setShowKey(!showKey)}
						className="text-muted hover:text-fg transition-colors"
						title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
					>
						{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
					</button>
				</div>
				<div>
					<input
						type="text"
						inputMode="numeric"
						value={contextWindow}
						onChange={(e) => setContextWindow(e.target.value)}
						placeholder={t("settings.provider.custom.contextWindowPlaceholder")}
						className="w-full rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					<p className="font-mono text-[10px] text-muted">{t("settings.provider.custom.contextWindowHint")}</p>
				</div>
				{supportsModelFetch ? (
				<div className="flex items-center gap-2">
					<Button size="sm" tone="neutral" onClick={handleFetch} disabled={!canFetch || fetching}>
						{fetching ? t("settings.provider.custom.fetchingModels") : t("settings.provider.custom.fetchModels")}
					</Button>
					{fetchedModels.length > 0 && (
						<span className="font-mono text-[10px] text-muted">
							{selectedModels.size}/{fetchedModels.length} {t("settings.provider.custom.modelsLabel")}
						</span>
					)}
				</div>
				) : (
					<p className="font-mono text-[10px] text-muted">{t("settings.provider.custom.anthropicFetchHint")}</p>
				)}
				{supportsModelFetch && fetchError && (
					<p className="font-mono text-[10px] text-warning">{t("settings.provider.custom.fetchFailed")}</p>
				)}
				{supportsModelFetch && fetchedModels.length > 0 && (
					<div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface/50 p-2">
						{fetchedModels.map((id) => {
							const checked = selectedModels.has(id);
							return (
								<label
									key={id}
									className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-[11px] text-fg hover:bg-surface"
								>
									<input
										type="checkbox"
										checked={checked}
										onChange={() => toggleModel(id)}
										className="h-3.5 w-3.5"
									/>
									<span className="flex-1">{id}</span>
									{checked && <Check className="h-3.5 w-3.5 text-success" />}
								</label>
							);
						})}
					</div>
				)}
				<div className="flex items-center gap-2">
					<input
						type="text"
						value={manualModel}
						onChange={(e) => setManualModel(e.target.value)}
						placeholder={t("settings.provider.custom.manualModelPlaceholder")}
						onKeyDown={(e) => e.key === "Enter" && addManualModel()}
						className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					<Button size="sm" tone="neutral" onClick={addManualModel} disabled={!manualModel.trim()}>
						{t("settings.provider.custom.addModel")}
					</Button>
				</div>
				{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
				<div className="flex items-center gap-2">
					<Button size="sm" tone="accent" onClick={handleSave} disabled={saving || selectedModels.size === 0}>
						{saving ? t("settings.provider.saving") : t("settings.provider.save")}
					</Button>
					<Button size="sm" tone="neutral" onClick={onCancel}>
						{t("settings.provider.cancel")}
					</Button>
				</div>
			</div>
		</div>
	);
}

function ProviderTab({
	isSetupMode = false,
	onConfigured,
}: {
	isSetupMode?: boolean;
	onConfigured?: () => void | Promise<void>;
}) {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	// models.json load problems reported by the sidecar's model registry —
	// e.g. a provider entry that was skipped as invalid. Without this the
	// registry degrades silently and those models just never show up.
	const [modelsJsonError, setModelsJsonError] = useState<string | null>(null);
	// `null` = neither form shown; `"catalog"` = the existing inline form;
	// `"custom"` = the new OpenAI-compatible provider form.
	const [addMode, setAddMode] = useState<null | "catalog" | "custom">(
		isSetupMode ? "catalog" : null,
	);

	const refresh = useCallback(async () => {
		try {
			const list = await listProviders();
			setProviders(list);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
		// Best-effort: pull the registry's models.json load error alongside.
		// The sidecar may be unreachable (e.g. mid-restart) — then we simply
		// keep whatever we last knew.
		try {
			const r = await sendCommandAwait<{ loadError?: string }>({ type: "get_available_models" }, 8000);
			setModelsJsonError(r.data?.loadError ?? null);
		} catch {
			/* sidecar not reachable — leave as-is */
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("settings.provider.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("settings.provider.error", { error })}</div>
			</Card>
		);
	}

	const configured = providers.filter((p) => p.has_api_key);
	const available = providers.filter((p) => !p.has_api_key);

	const closeAddForm = () => setAddMode(null);
	const onSavedProvider = () => {
		closeAddForm();
		refresh();
		if (onConfigured) void onConfigured();
	};

	return (
		<div className="space-y-6">
			{modelsJsonError && (
				<Card className="border-warning/40 bg-warning/5">
					<div className="text-sm font-medium text-fg">{t("settings.provider.modelsJsonErrorTitle")}</div>
					<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
						{modelsJsonError}
					</pre>
				</Card>
			)}
			<Card>
				<div className="mb-3 flex items-center gap-2">
					<Button
						size="sm"
						tone={addMode === "custom" ? "accent" : "neutral"}
						variant="soft"
						iconLeft={<Sparkles className="h-3.5 w-3.5" />}
						onClick={() => setAddMode(addMode === "custom" ? null : "custom")}
						className="rounded-full"
					>
						{t("settings.provider.addCustom")}
					</Button>
					<Button
						size="sm"
						tone={addMode === "catalog" ? "accent" : "neutral"}
						variant="soft"
						iconLeft={<Plus className="h-3.5 w-3.5" />}
						onClick={() => setAddMode(addMode === "catalog" ? null : "catalog")}
						className="rounded-full"
					>
						{t("settings.provider.addProvider")}
					</Button>
				</div>

				{addMode === "catalog" && (
					<AddProviderInline
						available={available}
						onSaved={onSavedProvider}
						onCancel={closeAddForm}
					/>
				)}

				{addMode === "custom" && (
					<AddCustomProviderForm
						onSaved={onSavedProvider}
						onCancel={closeAddForm}
					/>
				)}

				{configured.length === 0 && !addMode && (
					<div className="py-6 text-center">
						<p className="font-mono text-xs text-muted">{t("settings.provider.noProviders")}</p>
						<p className="mt-1 font-mono text-[10px] text-muted">{t("settings.provider.noProvidersHint")}</p>
					</div>
				)}

				{configured.map((p) => (
					<ProviderRow
						key={p.id}
						provider={p}
						onRefresh={() => {
							refresh();
							if (onConfigured) void onConfigured();
						}}
					/>
				))}
			</Card>
		</div>
	);
}

interface PersonaData {
	soul: {
		path: string;
		content: string | null;
		uninitialized: boolean;
	};
	userProfile: { path: string; content: string } | null;
	memory: { path: string; content: string }[];
}

function PersonaRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
	return (
		<div className="border-b border-border/60 py-3 last:border-0">
			<div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-fg/80">
				{icon}
				{label}
			</div>
			<div className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{children}</div>
		</div>
	);
}

function PersonaTab() {
	const { t } = useTranslation();
	const [persona, setPersona] = useState<PersonaData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait<PersonaData>({ type: "get_persona" }, 10000);
				if (cancelled) return;
				if (r.data) setPersona(r.data);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (loading) {
		return (
			<Card>
				<div className="flex items-center gap-2 text-sm text-muted">
					<Sparkles className="h-4 w-4 animate-pulse" />
					{t("settings.persona.loading")}
				</div>
			</Card>
		);
	}

	if (error || !persona) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("settings.persona.error", { error: error || "—" })}</div>
			</Card>
		);
	}

	const soul = parseSoul(persona.soul?.content ?? null);
	const agentName = deriveAgentName(soul);
	const agentRole = deriveAgentRole(soul);
	const identity = soul?.section("Identity") ?? null;
	const values = soul?.section("Values") ?? null;
	const voice = soul?.section("Voice") ?? null;
	const hasIdentity = identity || values || voice || persona.soul?.uninitialized;

	return (
		<div className="space-y-6">
			<Card>
				<div className="mb-3">
					<div className="flex items-center gap-2 text-sm font-medium text-fg">
						<Bot className="h-4 w-4" />
						{t("settings.persona.identityTitle")}
					</div>
					<div className="mt-1 font-mono text-[11px] text-muted">
						{agentName}{agentRole ? ` · ${agentRole}` : ""}
					</div>
					{persona.soul?.uninitialized && (
						<div className="mt-2 font-mono text-[11px] text-warning">
							{t("settings.persona.uninitialized")}
						</div>
					)}
				</div>
				{hasIdentity && (
					<div>
						{identity && (
							<PersonaRow icon={<User className="h-3.5 w-3.5" />} label={t("settings.persona.identity")}>
								{identity}
							</PersonaRow>
						)}
						{values && (
							<PersonaRow icon={<Brain className="h-3.5 w-3.5" />} label={t("settings.persona.values")}>
								{values}
							</PersonaRow>
						)}
						{voice && (
							<PersonaRow icon={<MessageSquare className="h-3.5 w-3.5" />} label={t("settings.persona.voice")}>
								{voice}
							</PersonaRow>
						)}
					</div>
				)}
			</Card>

			<Card>
				<div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
					<User className="h-4 w-4" />
					{t("settings.persona.memoryTitle")}
				</div>
				{persona.userProfile?.content ? (
					<div className="prose-persona text-sm leading-relaxed text-muted">
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{persona.userProfile.content}</ReactMarkdown>
					</div>
				) : (
					<div className="py-3 font-mono text-xs text-muted">{t("settings.persona.memoryEmpty")}</div>
				)}
			</Card>
		</div>
	);
}

function SetupBanner({ state }: { state: RpcSessionState | null }) {
	const { t } = useTranslation();
	const isSetup = !state || state.model === undefined;
	if (!isSetup) return null;
	return (
		<Card className="border-accent/40 bg-accent/5">
			<div className="flex items-start gap-3">
				<Key className="mt-0.5 h-5 w-5 text-accent" />
				<div className="flex-1 space-y-1">
					<div className="text-sm font-medium text-fg">{t("settings.setup.bannerTitle")}</div>
					<div className="font-mono text-xs text-muted">{t("settings.setup.bannerBody")}</div>
				</div>
			</div>
		</Card>
	);
}

export default function SettingsView({
	state,
	onRestartSidecar,
}: {
	state: RpcSessionState | null;
	onRestartSidecar?: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	// First-run / unconfigured-key setup mode is signaled by ?setup=true in the
	// URL. App.tsx redirects there when the sidecar reports state.model === undefined.
	const isSetupMode = new URLSearchParams(location.search).get("setup") === "true";
	const [tab, setTab] = useState<"general" | "provider" | "persona">(isSetupMode ? "provider" : "general");
	const [restarting, setRestarting] = useState(false);
	const [restartError, setRestartError] = useState("");
	const handleConfigured = useCallback(async () => {
		// Prefer the sidecar-restart path (re-scans modelRegistry with the new key).
		// Fall back to "just go back to chat" if no restart callback was provided
		// (e.g. web/preview builds without Tauri).
		if (onRestartSidecar) {
			setRestarting(true);
			setRestartError("");
			try {
				await onRestartSidecar();
				navigate("/", { replace: true });
			} catch (e) {
				setRestartError(e instanceof Error ? e.message : String(e));
			} finally {
				setRestarting(false);
			}
		} else {
			navigate("/", { replace: true });
		}
	}, [onRestartSidecar, navigate]);

	// Track browser history position so we can enable/disable back/forward.
	// react-router v6 stores { idx, usr, key } on window.history.state.
	const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
	const maxIdxRef = useRef(histIdx);
	if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	// Reset the forward ceiling whenever location changes to a fresh entry.
	useEffect(() => {
		if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	}, [histIdx, location.key]);
	const canBack = histIdx > 0;
	const canForward = histIdx < maxIdxRef.current;

	return (
		<div className="flex h-full flex-col">
			{/* Top bar — sits next to the sidebar collapse button; holds back/forward nav */}
			<div
				data-tauri-drag-region
				className={cn(
					"flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface/80 pr-6 backdrop-blur transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			>
				<button
					data-no-drag
					type="button"
					onClick={() => navigate(-1)}
					disabled={!canBack}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canBack ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.back")}
				>
					<ArrowLeft className="h-4 w-4" />
				</button>
				<button
					data-no-drag
					type="button"
					onClick={() => navigate(1)}
					disabled={!canForward}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canForward ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.forward")}
				>
					<ArrowRight className="h-4 w-4" />
				</button>
			</div>

			{/* Scrollable content — scrollbar hidden, but still scrollable */}
			<div className="scrollbar-hide flex-1 overflow-y-auto">
				<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
					<PageHeader title={isSetupMode ? t("settings.setup.title") : t("settings.title")} />

					{isSetupMode && (
						<div className="mb-6">
							<SetupBanner state={state} />
							{restarting && (
								<p className="mt-2 font-mono text-xs text-muted">
									{t("settings.setup.restarting")}
								</p>
							)}
							{restartError && (
								<p className="mt-2 font-mono text-xs text-danger">{restartError}</p>
							)}
						</div>
					)}

					<div className="mb-6 flex gap-2">
					<button
						onClick={() => setTab("general")}
						className={cn(
							"flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
							tab === "general"
								? "bg-accent text-accent-fg"
								: "bg-surface-2 text-muted hover:text-fg",
						)}
					>
						<Layers className="h-4 w-4" />
						{t("settings.tabs.general")}
					</button>
					<button
						onClick={() => setTab("provider")}
						className={cn(
							"flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
							tab === "provider"
								? "bg-accent text-accent-fg"
								: "bg-surface-2 text-muted hover:text-fg",
						)}
					>
						<Key className="h-4 w-4" />
						{t("settings.tabs.provider")}
					</button>
					<button
						onClick={() => setTab("persona")}
						className={cn(
							"flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
							tab === "persona"
								? "bg-accent text-accent-fg"
								: "bg-surface-2 text-muted hover:text-fg",
						)}
					>
						<Bot className="h-4 w-4" />
						{t("settings.tabs.persona")}
					</button>
				</div>

					{tab === "general" ? (
						<GeneralTab state={state} />
					) : tab === "provider" ? (
						<ProviderTab isSetupMode={isSetupMode} onConfigured={handleConfigured} />
					) : (
						<PersonaTab />
					)}
				</div>
			</div>
		</div>
	);
}
