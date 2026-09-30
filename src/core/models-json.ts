/**
 * Helpers for reading and mutating the user-level `models.json` (the file at
 * `~/.zharness/agent/models.json` that `ModelRegistry.loadCustomModels` reads on
 * startup and after a `reload_providers` broadcast).
 *
 * The GUI bridge (`add_custom_provider` in `apps/desktop/src/bridge.rs`) and
 * the TUI process both write this file, so all mutations go through
 * `proper-lockfile` to avoid lost updates across processes.
 *
 * Also exposes `fetchOpenAIModels` — a `GET {baseUrl}/models` call that returns
 * `{id: string}[]` for use by the "Custom / OpenAI-compatible" provider form.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { getModelsPath } from "../config.js";

/** Minimal shape of a model entry the UI cares about from `/v1/models`. */
export interface OpenAIModel {
	id: string;
}

/** Inputs for `mergeCustomProvider`. */
export interface CustomProviderInput {
	/** Provider id — must be non-empty, [A-Za-z0-9_-]+ only. */
	name: string;
	/** e.g. `https://ark.cn-beijing.volces.com/api/v3`. Trailing slash is fine. */
	baseUrl: string;
	/** API key (or `null` to inherit from env vars). */
	apiKey: string | null;
	/** At least one model id. */
	modelIds: string[];
	/** Wire protocol — defaults to {@link DEFAULT_API}. */
	api?: string;
}

/** Wire protocols a GUI-added custom provider may use. Mirrors the pi-ai `Api` union subset that makes sense for custom endpoints. */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "anthropic-messages", "openai-responses"] as const;

/** Default protocol — covers Volcano Ark, OneAPI, LM Studio, most OpenAI-compat proxies. */
const DEFAULT_API = "openai-completions";

/** Same defaults the registry uses for built-in models when the user omits them. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** Returns true iff `s` is a valid provider id (non-empty, [A-Za-z0-9_-]+). */
export function isValidProviderName(s: string): boolean {
	return s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Build the JSON object that goes under `providers[name]` in models.json. */
function buildProviderEntry(input: CustomProviderInput): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		baseUrl: input.baseUrl.replace(/\/+$/, ""),
		api: input.api ?? DEFAULT_API,
		models: input.modelIds.map((id) => ({
			id,
			name: id,
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		})),
	};
	if (input.apiKey !== null) {
		entry.apiKey = input.apiKey;
	}
	return entry;
}

/**
 * Merge a custom provider into `~/.zharness/agent/models.json`.
 *
 * - Creates the file (and parent dir) if missing.
 * - Existing providers with a different name are preserved.
 * - A provider with the same name is overwritten (the form's "edit" path is
 *   delete-then-add today, but this makes the function idempotent).
 *
 * Throws if the file exists but contains invalid JSON, or if `name` fails
 * `isValidProviderName`.
 */
export async function mergeCustomProvider(input: CustomProviderInput): Promise<void> {
	if (!isValidProviderName(input.name)) {
		throw new Error(
			`Invalid provider name "${input.name}": must be non-empty and contain only letters, digits, '-' or '_'`,
		);
	}
	if (!/^https?:\/\//.test(input.baseUrl)) {
		throw new Error(`Invalid baseUrl "${input.baseUrl}": must start with http:// or https://`);
	}
	if (input.modelIds.length === 0) {
		throw new Error("At least one model id is required");
	}
	if (input.api !== undefined && !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(input.api)) {
		throw new Error(
			`Invalid api "${input.api}": must be one of ${CUSTOM_PROVIDER_APIS.join(", ")}`,
		);
	}

	const path = getModelsPath();
	ensureParentDir(path);

	try {
		await lockfile.lock(path, {
			retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
			stale: 30_000,
		});
	} catch (err) {
		// If the file doesn't exist yet, proper-lockfile refuses. Create an empty
		// stub so the lock can be acquired.
		if (!existsSync(path)) {
			writeFileSync(path, "{}\n", "utf-8");
			await lockfile.lock(path, {
				retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
				stale: 30_000,
			});
		} else {
			throw new Error(`Failed to lock models.json: ${(err as Error).message}`);
		}
	}

	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("models.json root must be an object");
		}
		if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
			parsed.providers = {};
		}
		parsed.providers[input.name] = buildProviderEntry(input);
		writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
	} finally {
		await lockfile.unlock(path).catch(() => {
			// Unlock failures are non-fatal: the next lock attempt will block.
		});
	}
}

/**
 * Remove a custom provider from `~/.zharness/agent/models.json`.
 *
 * No-op if the file or the entry doesn't exist. Throws on invalid JSON so the
 * user can fix the file by hand rather than silently losing their config.
 */
export async function removeCustomProvider(name: string): Promise<void> {
	if (!isValidProviderName(name)) {
		throw new Error(`Invalid provider name "${name}"`);
	}

	const path = getModelsPath();
	if (!existsSync(path)) return;
	ensureParentDir(path);

	await lockfile.lock(path, {
		retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
		stale: 30_000,
	});

	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("models.json root must be an object");
		}
		if (parsed.providers && name in parsed.providers) {
			delete parsed.providers[name];
			writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
		}
	} finally {
		await lockfile.unlock(path).catch(() => {});
	}
}

/**
 * Call `{baseUrl}/models` and return the `id`s. Returns `[]` on any error
 * (network failure, non-2xx, malformed body) so the UI can fall back to a
 * free-text model id input.
 *
 * Uses Node's built-in `fetch` (Node 18+). Times out after 10s to avoid
 * leaving the form hanging on a misconfigured URL.
 */
export async function fetchOpenAIModels(baseUrl: string, apiKey: string | null): Promise<OpenAIModel[]> {
	const url = baseUrl.replace(/\/+$/, "") + "/models";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);

	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
		if (!resp.ok) return [];
		const body = (await resp.json()) as { data?: Array<{ id?: unknown }> } | unknown;
		if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray((body as { data: unknown }).data)) {
			return [];
		}
		return (body as { data: Array<{ id?: unknown }> }).data
			.filter((m): m is { id: string } => typeof m?.id === "string")
			.map((m) => ({ id: m.id }));
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

function ensureParentDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}
