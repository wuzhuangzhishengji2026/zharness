import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	fetchOpenAIModels,
	isValidProviderName,
	mergeCustomProvider,
	removeCustomProvider,
} from "../src/core/models-json.js";
import { ENV_AGENT_DIR } from "../src/config.js";

describe("models-json", () => {
	let tempDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `zharness-test-models-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		originalEnv = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalEnv;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	describe("isValidProviderName", () => {
		test("accepts letters, digits, dashes, underscores", () => {
			expect(isValidProviderName("volcano-ark")).toBe(true);
			expect(isValidProviderName("openai_proxy")).toBe(true);
			expect(isValidProviderName("x1")).toBe(true);
		});
		test("rejects empty, spaces, slashes, dots, other punctuation", () => {
			expect(isValidProviderName("")).toBe(false);
			expect(isValidProviderName("has space")).toBe(false);
			expect(isValidProviderName("has/slash")).toBe(false);
			expect(isValidProviderName("has.dot")).toBe(false);
			expect(isValidProviderName("has:colon")).toBe(false);
		});
	});

	describe("mergeCustomProvider", () => {
		const baseInput = {
			name: "volcano-ark",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3/",
			apiKey: "sk-test",
			modelIds: ["ep-abc-123", "ep-def-456"],
		};
		const modelsPath = () => join(tempDir, "models.json");

		test("creates the file when missing", async () => {
			expect(existsSync(modelsPath())).toBe(false);
			await mergeCustomProvider(baseInput);
			expect(existsSync(modelsPath())).toBe(true);
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed.providers["volcano-ark"].baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
			expect(parsed.providers["volcano-ark"].apiKey).toBe("sk-test");
			expect(parsed.providers["volcano-ark"].api).toBe("openai-completions");
			expect(parsed.providers["volcano-ark"].models).toHaveLength(2);
			expect(parsed.providers["volcano-ark"].models[0].id).toBe("ep-abc-123");
		});

		test("preserves other providers when adding a new one", async () => {
			writeFileSync(
				modelsPath(),
				JSON.stringify({ providers: { other: { apiKey: "k", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m" }] } } }),
			);
			await mergeCustomProvider(baseInput);
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(Object.keys(parsed.providers).sort()).toEqual(["other", "volcano-ark"]);
			expect(parsed.providers.other.apiKey).toBe("k");
		});

		test("overwrites a provider with the same name", async () => {
			await mergeCustomProvider(baseInput);
			await mergeCustomProvider({ ...baseInput, apiKey: "sk-new" });
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed.providers["volcano-ark"].apiKey).toBe("sk-new");
		});

		test("omits apiKey when null (env-var lookup)", async () => {
			await mergeCustomProvider({ ...baseInput, apiKey: null });
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect("apiKey" in parsed.providers["volcano-ark"]).toBe(false);
		});

		test("defaults api to openai-completions", async () => {
			await mergeCustomProvider(baseInput);
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed.providers["volcano-ark"].api).toBe("openai-completions");
		});

		test("persists an explicit api protocol", async () => {
			await mergeCustomProvider({ ...baseInput, api: "anthropic-messages" });
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed.providers["volcano-ark"].api).toBe("anthropic-messages");
			await mergeCustomProvider({ ...baseInput, api: "openai-responses" });
			const parsed2 = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed2.providers["volcano-ark"].api).toBe("openai-responses");
		});

		test("rejects an api outside the whitelist", async () => {
			await expect(mergeCustomProvider({ ...baseInput, api: "google-generative-ai" })).rejects.toThrow(/Invalid api/);
		});

		test("rejects invalid provider name", async () => {
			await expect(mergeCustomProvider({ ...baseInput, name: "has space" })).rejects.toThrow(/Invalid provider name/);
			await expect(mergeCustomProvider({ ...baseInput, name: "" })).rejects.toThrow(/Invalid provider name/);
		});

		test("rejects invalid baseUrl", async () => {
			await expect(mergeCustomProvider({ ...baseInput, baseUrl: "ftp://x" })).rejects.toThrow(/Invalid baseUrl/);
		});

		test("rejects empty model list", async () => {
			await expect(mergeCustomProvider({ ...baseInput, modelIds: [] })).rejects.toThrow(/At least one model id/);
		});

		test("throws on corrupted existing file (does not silently overwrite)", async () => {
			writeFileSync(modelsPath(), "{not valid json");
			await expect(mergeCustomProvider(baseInput)).rejects.toThrow();
		});
	});

	describe("removeCustomProvider", () => {
		const baseInput = {
			name: "volcano-ark",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
			apiKey: "sk-test",
			modelIds: ["ep-abc-123"],
		};
		const modelsPath = () => join(tempDir, "models.json");

		test("removes the named entry, keeps others", async () => {
			await mergeCustomProvider(baseInput);
			await mergeCustomProvider({ ...baseInput, name: "other", modelIds: ["m1"] });
			await removeCustomProvider("volcano-ark");
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(Object.keys(parsed.providers)).toEqual(["other"]);
		});

		test("is a no-op if the entry is missing", async () => {
			await mergeCustomProvider(baseInput);
			await removeCustomProvider("nonexistent");
			const parsed = JSON.parse(readFileSync(modelsPath(), "utf-8"));
			expect(parsed.providers["volcano-ark"]).toBeDefined();
		});

		test("is a no-op if the file does not exist", async () => {
			await removeCustomProvider("anything");
			expect(existsSync(modelsPath())).toBe(false);
		});
	});

	describe("fetchOpenAIModels", () => {
		type Handler = (req: { url: string; headers: Record<string, string> }) => { status: number; body: string };

		async function withMockServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
			const server = createServer((req, res) => {
				const url = req.url ?? "";
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (Array.isArray(v)) headers[k] = v.join(",");
					else if (typeof v === "string") headers[k] = v;
				}
				const out = handler({ url, headers });
				res.statusCode = out.status;
				res.setHeader("Content-Type", "application/json");
				res.end(out.body);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const addr = server.address() as AddressInfo;
			return {
				url: `http://127.0.0.1:${addr.port}`,
				close: () => new Promise<void>((resolve) => server.close(() => resolve())),
			};
		}

		test("returns id list from a well-formed /v1/models response", async () => {
			const { url, close } = await withMockServer(({ url }) => {
				expect(url).toBe("/models");
				return { status: 200, body: JSON.stringify({ data: [{ id: "ep-1" }, { id: "ep-2" }, { id: "ep-3" }] }) };
			});
			try {
				const models = await fetchOpenAIModels(url, "sk-test");
				expect(models).toEqual([{ id: "ep-1" }, { id: "ep-2" }, { id: "ep-3" }]);
			} finally {
				await close();
			}
		});

		test("sends Authorization: Bearer header when apiKey provided", async () => {
			let receivedAuth: string | undefined;
			const { url, close } = await withMockServer(({ headers }) => {
				receivedAuth = headers.authorization;
				return { status: 200, body: JSON.stringify({ data: [] }) };
			});
			try {
				await fetchOpenAIModels(url, "sk-xyz");
				expect(receivedAuth).toBe("Bearer sk-xyz");
			} finally {
				await close();
			}
		});

		test("omits Authorization header when apiKey is null", async () => {
			let receivedAuth: string | undefined;
			const { url, close } = await withMockServer(({ headers }) => {
				receivedAuth = headers.authorization;
				return { status: 200, body: JSON.stringify({ data: [] }) };
			});
			try {
				await fetchOpenAIModels(url, null);
				expect(receivedAuth).toBeUndefined();
			} finally {
				await close();
			}
		});

		test("returns [] on 401 (no throw)", async () => {
			const { url, close } = await withMockServer(() => ({ status: 401, body: '{"error":"unauthorized"}' }));
			try {
				const models = await fetchOpenAIModels(url, "bad");
				expect(models).toEqual([]);
			} finally {
				await close();
			}
		});

		test("returns [] on malformed body (no throw)", async () => {
			const { url, close } = await withMockServer(() => ({ status: 200, body: "{not valid json" }));
			try {
				const models = await fetchOpenAIModels(url, null);
				expect(models).toEqual([]);
			} finally {
				await close();
			}
		});

		test("returns [] when body has no data field", async () => {
			const { url, close } = await withMockServer(() => ({ status: 200, body: JSON.stringify({ models: [] }) }));
			try {
				const models = await fetchOpenAIModels(url, null);
				expect(models).toEqual([]);
			} finally {
				await close();
			}
		});

		test("strips trailing slash from baseUrl", async () => {
			let seenPath: string | undefined;
			const { url, close } = await withMockServer(({ url: reqUrl }) => {
				seenPath = reqUrl;
				return { status: 200, body: JSON.stringify({ data: [] }) };
			});
			try {
				await fetchOpenAIModels(url + "/", null);
				expect(seenPath).toBe("/models");
			} finally {
				await close();
			}
		});

		test("returns [] when the server is unreachable", async () => {
			// 127.0.0.1:1 is a privileged port nothing should be listening on
			const models = await fetchOpenAIModels("http://127.0.0.1:1", null);
			expect(models).toEqual([]);
		});
	});
});
