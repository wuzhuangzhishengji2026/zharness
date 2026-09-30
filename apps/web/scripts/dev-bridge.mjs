import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Built-in provider id -> display name map.
 *
 * Source of truth: `dist/providers.json`, generated from pi-ai at build time
 * (scripts/generate-providers.mjs). Falls back to importing pi-ai directly if
 * the generated file is missing (e.g. before a build). Keep in sync with
 * getProviderDisplayName() in src/core/model-registry.ts.
 */
let providerNamesCache = null;
async function loadProviderNames() {
	if (providerNamesCache) return providerNamesCache;
	const generated = path.join(fileURLToPath(new URL("../../..", import.meta.url)), "dist", "providers.json");
	try {
		providerNamesCache = JSON.parse(fs.readFileSync(generated, "utf8"));
		return providerNamesCache;
	} catch {
		// Pre-build dev fallback: derive from pi-ai directly.
		try {
			const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
			const map = {};
			for (const p of builtinProviders()) map[p.id] = p.name;
			providerNamesCache = map;
			return map;
		} catch {
			providerNamesCache = {};
			return providerNamesCache;
		}
	}
}

function authPath() {
	return path.join(os.homedir(), ".zharness", "agent", "auth.json");
}

function readAuth() {
	try {
		const raw = fs.readFileSync(authPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeAuth(data) {
	const dir = path.dirname(authPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(authPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function modelsPath() {
	return path.join(os.homedir(), ".zharness", "agent", "models.json");
}

function readModels() {
	try {
		const raw = fs.readFileSync(modelsPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeModels(data) {
	const dir = path.dirname(modelsPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(modelsPath(), JSON.stringify(data, null, 2) + "\n");
}

function isValidProviderName(name) {
	return typeof name === "string" && name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Add a custom provider (OpenAI-compatible, Anthropic-messages, or OpenAI
 * Responses) to `~/.zharness/agent/models.json` —
 * the web-dev counterpart of the Tauri command `add_custom_provider`
 * (apps/desktop/src/bridge.rs). Entry shape matches the TypeScript
 * `ProviderConfigSchema` in `src/core/model-registry.ts`.
 *
 * Returns `{}` on success or `{ error }` on invalid input.
 */
function addCustomProviderEntry(name, baseUrl, apiKey, modelIds, contextWindow, api) {
	if (!isValidProviderName(name)) {
		return {
			error: `Invalid provider name "${name}": must be non-empty and contain only letters, digits, '-' or '_'`,
		};
	}
	if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
		return { error: `Invalid baseUrl "${baseUrl}": must start with http:// or https://` };
	}
	if (!Array.isArray(modelIds) || modelIds.length === 0) {
		return { error: "At least one model id is required" };
	}
	for (const id of modelIds) {
		if (typeof id !== "string" || id.trim() === "") {
			return { error: "Model id must not be empty" };
		}
	}
	// Drives the compaction threshold — keep parity with bridge.rs.
	const resolvedContextWindow = contextWindow ?? 128_000;
	if (!Number.isInteger(resolvedContextWindow) || resolvedContextWindow <= 0) {
		return { error: `Invalid contextWindow "${contextWindow}": must be a positive number of tokens` };
	}
	// Wire protocol — same whitelist as bridge.rs; default keeps older GUIs working.
	const CUSTOM_PROVIDER_APIS = ["openai-completions", "anthropic-messages", "openai-responses"];
	const resolvedApi = api ?? "openai-completions";
	if (!CUSTOM_PROVIDER_APIS.includes(resolvedApi)) {
		return { error: `Invalid api "${api}": must be one of ${CUSTOM_PROVIDER_APIS.join(", ")}` };
	}

	const config = readModels();
	if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
		config.providers = {};
	}
	const entry = {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		api: resolvedApi,
		models: modelIds.map((id) => ({ id, name: id, contextWindow: resolvedContextWindow, maxTokens: 16_384 })),
	};
	if (typeof apiKey === "string" && apiKey !== "") {
		entry.apiKey = apiKey;
	}
	config.providers[name] = entry;
	writeModels(config);
	return {};
}

/**
 * Remove a custom provider from `~/.zharness/agent/models.json`. No-op if the
 * file or the entry is missing. Returns `{}` or `{ error }`.
 */
function removeCustomProviderEntry(name) {
	if (!isValidProviderName(name)) {
		return { error: `Invalid provider name "${name}"` };
	}
	const config = readModels();
	if (config.providers && typeof config.providers === "object" && name in config.providers) {
		delete config.providers[name];
		writeModels(config);
	}
	return {};
}

async function listProviders() {
	const auth = readAuth();
	const names = await loadProviderNames();
	const models = readModels();
	const custom =
		models.providers && typeof models.providers === "object" && !Array.isArray(models.providers)
			? models.providers
			: {};
	// Stable display order: built-in providers sorted by id, then custom ones.
	const builtinIds = Object.keys(names).sort();
	const providers = [];
	const seen = new Set();
	for (const id of builtinIds) {
		seen.add(id);
		const cred = auth[id];
		providers.push({
			id,
			name: names[id] ?? id,
			has_api_key: cred != null,
			auth_type: cred?.type ?? null,
		});
	}
	for (const key of Object.keys(auth)) {
		if (!seen.has(key)) {
			seen.add(key);
			providers.push({ id: key, name: key, has_api_key: true, auth_type: auth[key]?.type ?? null });
		}
	}
	// Custom providers from models.json (mirrors the Rust list_providers):
	// surfaced even without an apiKey so the user can edit/remove them.
	for (const key of Object.keys(custom)) {
		if (!seen.has(key)) {
			seen.add(key);
			const entry = custom[key];
			const hasKey = typeof entry?.apiKey === "string" && entry.apiKey !== "";
			providers.push({
				id: key,
				name: key,
				has_api_key: hasKey,
				auth_type: hasKey ? "api_key" : null,
			});
		}
	}
	return providers;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (e) {
				reject(e);
			}
		});
	});
}

function sendJson(res, status, obj) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(obj));
}

/**
 * Vite dev plugin: spawns `zharness rpc` as a child process and exposes
 * HTTP endpoints for the browser to communicate with it.
 *
 *   POST /rpc/command   → send a JSON command to zharness stdin
 *   GET  /rpc/events    → SSE stream of stdout lines (responses + events)
 *   GET  /rpc/state     → convenience: sends get_state and returns the response
 *
 * In Tauri mode this plugin is not needed — the Rust bridge handles IPC.
 */
export function zharnessRpcBridge() {
	let child = null;
	let childCwd = null;
	let stdoutBuffer = [];
	const sseClients = new Set();
	// 串行化工作区切换,避免并发 /rpc/init 触发重复 kill/spawn。
	let switchChain = Promise.resolve();

	function spawnRpc(command, args, cwd) {
		child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
		});
		childCwd = cwd;
		// 新 sidecar = 新会话上下文:清空输出缓冲,防止 /rpc/init 扫到
		// 上一个 sidecar 残留的 get_state 响应。
		stdoutBuffer = [];
		// sidecar 自报的规范化 cwd(从 get_state 响应提取),注入事件 _cwd 用;
		// 与前端 App 的 workspace state(同样取自 state.cwd)严格一致。
		let stateCwd = null;
		let lineBuf = "";
		child.stdout.on("data", (chunk) => {
			lineBuf += chunk.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop();
			for (const line of lines) {
				if (!line.trim()) continue;
				// 对齐 Tauri bridge(Rust 侧给事件 tag _cwd):浏览器端事件没有来源
				// 标记时,ChatView 的 isForCurrent 恒 false,流式消息全进后台缓存
				// 不渲染。这里给事件行注入 _cwd;response 行原样转发。
				let out = line;
				try {
					const parsed = JSON.parse(line);
					if (parsed && typeof parsed === "object") {
						if (parsed.type === "response" && parsed.command === "get_state") {
							const c = parsed.data?.cwd;
							if (typeof c === "string" && c !== "") stateCwd = c;
						} else if (typeof parsed.event_id === "string" && parsed._cwd === undefined) {
							parsed._cwd = stateCwd ?? cwd;
							out = JSON.stringify(parsed);
						}
					}
				} catch { /* 非 JSON 行原样转发 */ }
				stdoutBuffer.push(out);
				for (const res of sseClients) {
					res.write(`data: ${out}\n\n`);
				}
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString().trim();
			if (text) console.error(`[zharness-rpc-bridge stderr] ${text}`);
		});

		child.on("error", (err) => {
			console.error(`[zharness-rpc-bridge] spawn error: ${err.message}`);
			child = null;
			childCwd = null;
			// `zharness` not on PATH (ENOENT) → fall back to the repo-local
			// build so the dev GUI works without a global install.
			if (err.code === "ENOENT" && command === "zharness") {
				const localCli = path.join(fileURLToPath(new URL("../../..", import.meta.url)), "dist", "src", "cli.js");
				if (fs.existsSync(localCli)) {
					console.log(`[zharness-rpc-bridge] retrying with node ${localCli}`);
					spawnRpc(process.execPath, [localCli, "--mode", "rpc"], cwd);
				}
			}
		});

		child.on("exit", (code, signal) => {
			console.log(`[zharness-rpc-bridge] child exited code=${code} signal=${signal}`);
			child = null;
			// childCwd 保留,崩溃后可按原目录按需重启
		});
	}

	/**
	 * 拉起 sidecar:优先仓库本地构建,保证网页端与当前代码一致。
	 * cwd 是主对话目录(~/.zharness/main)时附加 --main,与桌面端
	 * (bridge.rs is_persistent_chat 分支)对齐:main scope 的定时任务
	 * 只由 --main sidecar 的 SchedulerEngine 调度,不带该标记则主对话
	 * 的定时任务永远无人触发。
	 */
	function spawnSidecar(cwd) {
		const localCli = path.join(fileURLToPath(new URL("../../..", import.meta.url)), "dist", "src", "cli.js");
		const mainDir = process.env.ZHARNESS_DEV_MAIN_DIR || path.join(os.homedir(), ".zharness", "main");
		const isMain = path.resolve(cwd) === path.resolve(mainDir);
		const extraArgs = isMain ? ["--main", ...(process.env.ZHARNESS_DEV_MAIN_DIR ? ["--main-dir", mainDir] : [])] : [];
		if (fs.existsSync(localCli)) {
			console.log(`[zharness-rpc-bridge] spawning node ${localCli} --mode rpc${isMain ? " --main" : ""} (cwd: ${cwd})...`);
			spawnRpc(process.execPath, [localCli, "--mode", "rpc", ...extraArgs], cwd);
		} else {
			console.log(`[zharness-rpc-bridge] spawning zharness --mode rpc${isMain ? " --main" : ""} (cwd: ${cwd})...`);
			spawnRpc("zharness", ["--mode", "rpc", ...extraArgs], cwd);
		}
	}

	/**
	 * 确保 sidecar 在指定 cwd 运行。cwd 不同则先停掉旧进程再拉起新进程 ——
	 * 对齐桌面端「切换项目 = 切换该工作区独立 sidecar」的行为,看板/回放/
	 * 历史等按工作区隔离的数据随之切换。
	 */
	function ensureSidecar(cwd) {
		switchChain = switchChain.then(async () => {
			if (child && childCwd === cwd) return;
			if (child) {
				console.log(`[zharness-rpc-bridge] switching workspace: ${childCwd} -> ${cwd}`);
				const old = child;
				child = null;
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, 3000);
					old.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
					old.kill();
				});
			}
			if (!child) spawnSidecar(cwd);
		});
		return switchChain;
	}

	/** 解析 ?cwd= 参数:~ 展开为 home;目录不存在返回 null。 */
	function resolveCwd(raw) {
		let cwd = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
		if (cwd === null) return process.cwd();
		if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\")) {
			cwd = path.join(os.homedir(), cwd.slice(1));
		}
		const demoMainDir = process.env.ZHARNESS_DEV_MAIN_DIR;
		if (demoMainDir && path.resolve(cwd) === path.join(os.homedir(), ".zharness", "main")) {
			cwd = demoMainDir;
		}
		try {
			if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
		} catch {
			/* fall through */
		}
		return null;
	}

	return {
		name: "zharness-rpc-bridge",
		configureServer(server) {
		// Ask the rpc child to re-read auth.json / models.json — the web-dev
		// counterpart of the Rust bridge's `broadcast_to_all_sidecars`
		// ("reload_providers") so model auth and the registry stay fresh.
		function notifyReloadProviders() {
			if (child?.stdin?.writable) {
				child.stdin.write(JSON.stringify({ id: "dev-bridge-reload", type: "reload_providers" }) + "\n");
			}
		}

		void ensureSidecar(process.cwd());

			server.middlewares.use("/rpc/init", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			// 可选 ?cwd=:切换 sidecar 到指定工作区(网页端的「选择项目」)。
			const rawCwd = new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd");
			const cwd = resolveCwd(rawCwd);
			if (cwd === null) {
				sendJson(res, 400, { error: `workspace directory not found: ${rawCwd}` });
				return;
			}
			void ensureSidecar(cwd).then(() => {
				// Send get_state and wait for the response
				const cmd = JSON.stringify({ type: "get_state", id: "init" }) + "\n";
				if (!child?.stdin?.writable) {
					sendJson(res, 503, { error: "zharness not running" });
					return;
				}

				let resolved = false;
				const reply = (line) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(initTimer);
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(line);
				};
				const initTimer = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					sendJson(res, 504, { error: "init timed out" });
				}, 10000);

				// Resolve as soon as a get_state response lands in the buffer —
				// either already there (same sidecar re-init) or arriving later.
				const scanBuffer = () => {
					for (const line of stdoutBuffer) {
						try {
							const parsed = JSON.parse(line);
							if (parsed.type === "response" && parsed.command === "get_state") return line;
						} catch {}
					}
					return null;
				};
				const buffered = scanBuffer();
				if (buffered !== null) {
					reply(buffered);
					return;
				}
				const checkBuffer = setInterval(() => {
					if (resolved) {
						clearInterval(checkBuffer);
						return;
					}
					const line = scanBuffer();
					if (line !== null) {
						clearInterval(checkBuffer);
						reply(line);
					}
				}, 100);

				child.stdin.write(cmd);
			});
		});

		server.middlewares.use("/rpc/command", (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end("Method Not Allowed");
					return;
				}
				let body = "";
				req.on("data", (chunk) => (body += chunk));
				req.on("end", () => {
					try {
						const cmd = JSON.parse(body);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify(cmd) + "\n");
							res.statusCode = 200;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ ok: true }));
						} else {
							res.statusCode = 503;
							res.end(JSON.stringify({ error: "zharness process not running" }));
						}
					} catch (e) {
						res.statusCode = 400;
						res.end(JSON.stringify({ error: e.message }));
					}
				});
			});

			server.middlewares.use("/rpc/providers", (req, res) => {
				if (req.method === "GET") {
					listProviders().then((p) => sendJson(res, 200, p)).catch((e) => sendJson(res, 500, { error: e.message }));
					return;
				}
				if (req.method === "POST") {
				readJsonBody(req).then((body) => {
					// Custom OpenAI-compatible providers — the web-dev counterpart
					// of the Tauri commands add_custom_provider /
					// remove_custom_provider (apps/desktop/src/bridge.rs).
					if (body.action === "add_custom" || body.action === "remove_custom") {
						const result =
							body.action === "add_custom"
								? addCustomProviderEntry(body.name, body.baseUrl, body.apiKey, body.modelIds, body.contextWindow, body.api)
								: removeCustomProviderEntry(body.name);
						if (result.error) return sendJson(res, 400, { error: result.error });
						notifyReloadProviders();
						return sendJson(res, 200, { ok: true });
					}
					const { provider, apiKey, remove } = body;
					if (!provider) return sendJson(res, 400, { error: "provider required" });
					const auth = readAuth();
					if (remove) {
						delete auth[provider];
					} else {
						if (!apiKey) return sendJson(res, 400, { error: "apiKey required" });
						auth[provider] = { type: "api_key", key: apiKey };
					}
					writeAuth(auth);
					notifyReloadProviders();
					sendJson(res, 200, { ok: true });
				}).catch((e) => sendJson(res, 400, { error: e.message }));
				return;
			}
				res.statusCode = 405;
				res.end("Method Not Allowed");
			});

			server.middlewares.use("/rpc/events", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			// Send buffered lines first
			for (const line of stdoutBuffer) {
				res.write(`data: ${line}\n\n`);
			}
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
		});

		// 工作区列表 — 扫描 ~/.zharness/agent/workspaces/<ws>/meta.json,
		// 等价于 Tauri 的 list_workspaces 命令(apps/desktop/src/bridge.rs),
		// 让浏览器端侧边栏「项目」分组与桌面端一致。
		server.middlewares.use("/rpc/workspaces", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			try {
				const dir = path.join(os.homedir(), ".zharness", "agent", "workspaces");
				const list = [];
				if (fs.existsSync(dir)) {
					for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
						if (!entry.isDirectory()) continue;
						try {
							list.push(JSON.parse(fs.readFileSync(path.join(dir, entry.name, "meta.json"), "utf8")));
						} catch {
							// meta.json 缺失/损坏的工作区跳过
						}
					}
				}
				list.sort((a, b) => (b.last_accessed_at ?? 0) - (a.last_accessed_at ?? 0));
				sendJson(res, 200, list);
			} catch (e) {
				sendJson(res, 500, { error: e.message });
			}
		});

		// skills.sh 目录代理 — 浏览器直连会被 CORS 拦截(网页端技能列表为空),
		// 由 Node 侧拉取 HTML 再返回,等价于 Tauri 的 fetch_skills_sh 命令。
		server.middlewares.use("/rpc/skills-sh", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			fetch("https://www.skills.sh/", { headers: { Accept: "text/html" } })
				.then((upstream) => {
					if (!upstream.ok) throw new Error(`skills.sh responded ${upstream.status}`);
					return upstream.text();
				})
				.then((html) => {
					res.statusCode = 200;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(html);
				})
				.catch((e) => sendJson(res, 502, { error: e.message }));
		});
		},
	};
}
