/**
 * ZHarness serve mode — LAN bridge for mobile clients.
 *
 * Spawns the agent as an RPC-mode sidecar (same mechanism as the desktop
 * app's Tauri sidecar) and bridges it to WebSocket clients:
 *
 *   phone (WS/WSS)  ⇄  this server  ⇄  `node cli.js --mode rpc` sidecar
 *
 * Protocol (JSON frames):
 *   client → server: RpcCommand JSON frames (same table as `--mode rpc`),
 *     plus serve-level commands:
 *       - { type: "pair.claim", code, deviceName }   (no auth required)
 *       - { type: "events.resync", sinceSequence?, limit? }
 *       - { type: "ping" }
 *   server → client: { type: "response", id, command, success, data?, error? }
 *     and sidecar events wrapped as { type: "event", event }.
 *
 * Auth:
 *   - Unauthenticated sockets may only send pair.claim / ping.
 *   - pair.claim exchanges a one-time 6-digit code (printed on the console,
 *     5-minute TTL, single use) for a device token.
 *   - Sockets authenticate with `?token=` on the upgrade URL. Tokens are
 *     persisted only as sha256 hashes under <agentDir>/serve/devices.json.
 *
 * This server intentionally holds NO agent state: the append-only EventStore
 * in the sidecar remains the single source of truth, and the phone replays it
 * via events.resync. Restarting the bridge loses nothing.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { RpcClient } from "../rpc/rpc-client.js";

// ============================================================================
// Types
// ============================================================================

export interface ServeServerOptions {
	/** Workspace the sidecar agent runs in. */
	cwd: string;
	/** Bind address. Default 0.0.0.0 (LAN). Use 127.0.0.1 to keep it local. */
	host?: string;
	/** Bind port. Default 0 (ephemeral, printed on ready). */
	port?: string | number;
	/** Overrides the agent dir (device registry lives at <agentDir>/serve/). */
	agentDir?: string;
	/** Path to the CLI entry used to spawn the sidecar. Defaults to dist layout. */
	cliPath?: string;
	/** Called whenever a fresh pairing code is issued (also printed to console). */
	onPairingCode?: (info: PairingCodeInfo) => void;
	/** Called once the HTTP listener is bound. */
	onReady?: (info: { host: string; port: number }) => void;
}

export interface PairingCodeInfo {
	code: string;
	host: string;
	port: number;
	expiresAt: number;
}

export interface ServeServerHandle {
	port: number;
	host: string;
	/** URI payload a phone pairs with: zharness://pair?host=…&port=…&code=… */
	pairingUri(): string;
	/** Issue and print a fresh one-time pairing code (invalidates the old one). */
	newPairingCode(): PairingCodeInfo;
	stop(): Promise<void>;
}

interface DeviceRecord {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: number;
}

interface DevicesFile {
	version: 1;
	devices: DeviceRecord[];
}

/** Loose response shape — bridge relays frames without discriminating them. */
interface LooseRpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS_PER_SOCKET = 5;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const RESYNC_MAX_LIMIT = 5000;
const RESYNC_DEFAULT_LIMIT = 2000;
/** Sidecar events are wrapped before reaching clients; keep names stable. */
export const EVENT_FRAME_TYPE = "event";
export const RESPONSE_FRAME_TYPE = "response";

// ============================================================================
// Device token registry
// ============================================================================

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

class DeviceRegistry {
	private readonly filePath: string;
	private devices: DeviceRecord[];

	constructor(agentDir: string) {
		const dir = join(agentDir, "serve");
		mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, "devices.json");
		this.devices = this.load();
	}

	private load(): DeviceRecord[] {
		try {
			if (!existsSync(this.filePath)) return [];
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as DevicesFile;
			if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.devices)) return [];
			return parsed.devices.filter((d) => typeof d?.tokenHash === "string");
		} catch {
			return [];
		}
	}

	private save(): void {
		const payload: DevicesFile = { version: 1, devices: this.devices };
		writeFileSync(this.filePath, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
	}

	/** Create a device; returns the plaintext token exactly once. */
	register(name: string): { id: string; token: string } {
		const token = `zh_${randomBytes(32).toString("base64url")}`;
		const record: DeviceRecord = {
			id: `dev_${randomBytes(8).toString("hex")}`,
			name: name.slice(0, 80) || "unnamed device",
			tokenHash: sha256(token),
			createdAt: Date.now(),
		};
		this.devices.push(record);
		this.save();
		return { id: record.id, token };
	}

	verify(token: string): boolean {
		if (typeof token !== "string" || token.length < 16 || token.length > 256) return false;
		const hash = sha256(token);
		return this.devices.some((d) => d.tokenHash === hash);
	}

	count(): number {
		return this.devices.length;
	}
}

// ============================================================================
// Pairing codes (in-memory, single-use, one outstanding at a time)
// ============================================================================

class PairingCodeStore {
	private outstanding: { code: string; expiresAt: number } | null = null;

	issue(): { code: string; expiresAt: number } {
		this.outstanding = {
			code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
			expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
		};
		return { ...this.outstanding };
	}

	/** Returns true once if the code matches, is fresh, and unused. */
	consume(candidate: string): boolean {
		if (!this.outstanding) return false;
		const { code, expiresAt } = this.outstanding;
		this.outstanding = null; // single use regardless of match — avoid code grinding
		return Date.now() <= expiresAt && code === candidate;
	}

	/** Currently outstanding fresh code (for the pairing handoff page). */
	current(): { code: string; expiresAt: number } | null {
		if (!this.outstanding || Date.now() > this.outstanding.expiresAt) return null;
		return { ...this.outstanding };
	}
}

// ============================================================================
// Serve server
// ============================================================================

function resolveDefaultCliPath(): string {
	// Compiled layout: dist/packages/serve/server.js → dist/src/cli.js.
	// Source layout (tsx/tests): fall back to dist/src/cli.js under cwd.
	const fromModule = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
	if (existsSync(fromModule)) return fromModule;
	return resolve(process.cwd(), "dist/src/cli.js");
}

function privateName(cwd: string): string {
	return basename(resolve(cwd)) || "workspace";
}

/**
 * Best-effort LAN addresses for pairing links. When bound to 0.0.0.0 the
 * server cannot know which interface the phone will use; list all non-internal
 * IPv4 candidates, preferring typical home-LAN ranges and skipping link-local
 * (169.254.*) addresses a phone can never reach.
 */
function detectLanIps(): string[] {
	const candidates: Array<{ ip: string; score: number }> = [];
	for (const interfaces of Object.values(networkInterfaces())) {
		for (const info of interfaces ?? []) {
			if (info.family !== "IPv4" || info.internal) continue;
			const ip = info.address;
			if (ip.startsWith("169.254.")) continue; // APIPA / link-local
			let score = 1;
			if (ip.startsWith("192.168.")) score = 4;
			else if (ip.startsWith("10.")) score = 3;
			else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 3;
			candidates.push({ ip, score });
		}
	}
	return candidates.sort((a, b) => b.score - a.score).map((c) => c.ip);
}

interface SocketState {
	ws: WebSocket;
	authed: boolean;
	pairingAttempts: number;
}

export async function runServeServer(options: ServeServerOptions): Promise<ServeServerHandle> {
	const cwd = resolve(options.cwd);
	const host = options.host ?? "0.0.0.0";
	const agentDir = options.agentDir
		?? process.env.ZHARNESS_CODING_AGENT_DIR
		?? join(tmpdir(), "zharness-serve-fallback");
	const registry = new DeviceRegistry(agentDir);
	const pairing = new PairingCodeStore();
	const wsServer = new WebSocketServer({ noServer: true });
	const sockets = new Set<SocketState>();

	let sidecar: RpcClient | null = null;
	let sidecarStarting: Promise<RpcClient> | null = null;
	let sidecarCrashes = 0;
	const cliPath = options.cliPath ?? process.env.ZHARNESS_SERVE_CLI ?? resolveDefaultCliPath();

	const httpServer: Server = createServer((req, res) => {
		handleHttp(req, res, { cwd, pairing, sockets });
	});

	// ---- Sidecar lifecycle ---------------------------------------------------

	function broadcast(frame: object): void {
		const payload = JSON.stringify(frame);
		for (const socket of sockets) {
			if (socket.authed && socket.ws.readyState === WebSocket.OPEN) {
				socket.ws.send(payload);
			}
		}
	}

	async function ensureSidecar(): Promise<RpcClient> {
		if (sidecar) return sidecar;
		if (!sidecarStarting) {
			const client = new RpcClient({ cliPath, cwd });
			client.onEvent((event) => broadcast({ type: EVENT_FRAME_TYPE, event }));
			sidecarStarting = client.start().then(() => {
				sidecar = client;
				sidecarCrashes = 0;
				return client;
			}).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[serve] sidecar failed to start: ${message}`);
				throw new Error(`Agent sidecar failed to start: ${message}`);
			}).finally(() => {
				sidecarStarting = null;
			});
		}
		return sidecarStarting;
	}

	/** Called when the sidecar process is found dead (a send failed). */
	function handleSidecarDeath(): void {
		if (!sidecar) return;
		sidecar = null;
		broadcast({ type: EVENT_FRAME_TYPE, event: { type: "SIDECAR_EXITED" } });
		if (sockets.size > 0 && sidecarCrashes < 5) {
			sidecarCrashes += 1;
			const delay = Math.min(1000 * 2 ** sidecarCrashes, 30_000);
			console.error(`[serve] sidecar exited; respawning in ${delay}ms (attempt ${sidecarCrashes}/5)`);
			setTimeout(() => {
				void ensureSidecar().catch(() => { /* logged in ensureSidecar */ });
			}, delay);
		}
	}

	// ---- WS frame handling ---------------------------------------------------

	function sendError(socket: SocketState, id: unknown, command: string, error: string): void {
		socket.ws.send(JSON.stringify({
			id: typeof id === "string" ? id : undefined,
			type: RESPONSE_FRAME_TYPE,
			command,
			success: false,
			error,
		}));
	}

	async function handleFrame(socket: SocketState, raw: string | Buffer): Promise<void> {
		if (raw.length > MAX_FRAME_BYTES) {
			sendError(socket, undefined, "unknown", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
			return;
		}
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
		} catch {
			sendError(socket, undefined, "unknown", "invalid JSON frame");
			return;
		}
		const type = typeof frame.type === "string" ? frame.type : "";
		const id = frame.id;

		if (type === "ping") {
			socket.ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
			return;
		}

		if (!socket.authed) {
			if (type === "pair.claim") {
				claimPairing(socket, frame);
				return;
			}
			sendError(socket, id, type, "unauthorized: pair first (pair.claim) or pass ?token=");
			return;
		}

		if (type === "pair.claim") {
			sendError(socket, id, type, "already authenticated");
			return;
		}

		if (type === "events.resync") {
			await handleResync(socket, id, frame);
			return;
		}

		// Everything else rides the sidecar's existing RPC command table.
		try {
			const client = await ensureSidecar();
			const response = await client.send(frame as never) as LooseRpcResponse;
			// Rewrite the correlation id: the phone tracks its own frame id, not
			// the sidecar's internal req_N counter.
			socket.ws.send(JSON.stringify({ ...response, id: typeof id === "string" ? id : response.id }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/client not started/i.test(message)) handleSidecarDeath();
			sendError(socket, id, type, message);
		}
	}

	function claimPairing(socket: SocketState, frame: Record<string, unknown>): void {
		socket.pairingAttempts += 1;
		if (socket.pairingAttempts > MAX_PAIRING_ATTEMPTS_PER_SOCKET) {
			sendError(socket, frame.id, "pair.claim", "too many pairing attempts");
			socket.ws.close(4001, "too many pairing attempts");
			return;
		}
		const code = typeof frame.code === "string" ? frame.code.trim() : "";
		if (!pairing.consume(code)) {
			sendError(socket, frame.id, "pair.claim", "invalid or expired pairing code");
			return;
		}
		const deviceName = typeof frame.deviceName === "string" ? frame.deviceName : "";
		const { token } = registry.register(deviceName);
		socket.authed = true;
		socket.ws.send(JSON.stringify({
			id: typeof frame.id === "string" ? frame.id : undefined,
			type: RESPONSE_FRAME_TYPE,
			command: "pair.claim",
			success: true,
			data: {
				token,
				workspace: { name: privateName(cwd), cwd },
				devices: registry.count(),
			},
		}));
		console.log(`[serve] paired device "${deviceName || "unnamed"}" (total: ${registry.count()})`);
	}

	async function handleResync(socket: SocketState, id: unknown, frame: Record<string, unknown>): Promise<void> {
		const since = typeof frame.sinceSequence === "number" && Number.isFinite(frame.sinceSequence)
			? frame.sinceSequence
			: undefined;
		const limitRaw = typeof frame.limit === "number" ? frame.limit : RESYNC_DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(Math.floor(limitRaw), RESYNC_MAX_LIMIT));
		try {
			const client = await ensureSidecar();
			const response = await client.send({
				type: "get_events",
				limit,
				...(since !== undefined ? { sinceSequence: since } : {}),
			} as never) as LooseRpcResponse;
			if (!response.success) {
				socket.ws.send(JSON.stringify(response));
				return;
			}
			const data = response.data as { events?: Array<Record<string, unknown>> } | undefined;
			const events = data?.events ?? [];
			const sequences = events
				.map((e) => e.sequence)
				.filter((s): s is number => typeof s === "number");
			const oldest = sequences.length > 0 ? Math.min(...sequences) : undefined;
			// complete = no gap between the client's cursor and the oldest event
			// we returned. When a gap remains, the client should full-refresh
			// (its offline window exceeded the fetch limit).
			const complete = since === undefined
				|| events.length < limit
				|| (typeof oldest === "number" && oldest <= since + 1);
			socket.ws.send(JSON.stringify({
				id: typeof id === "string" ? id : undefined,
				type: RESPONSE_FRAME_TYPE,
				command: "events.resync",
				success: true,
				data: {
					events,
					complete,
					cursor: sequences.length > 0 ? Math.max(...sequences) : since,
				},
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/client not started/i.test(message)) handleSidecarDeath();
			sendError(socket, id, "events.resync", message);
		}
	}

	// ---- Server wiring -------------------------------------------------------

	httpServer.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		const token = url.searchParams.get("token") ?? "";
		wsServer.handleUpgrade(req, socket, head, (ws) => {
			const state: SocketState = { ws, authed: registry.verify(token), pairingAttempts: 0 };
			sockets.add(state);
			ws.on("message", (data) => {
				void handleFrame(state, data as string | Buffer).catch((error) => {
					sendError(state, undefined, "unknown", error instanceof Error ? error.message : String(error));
				});
			});
			ws.on("close", () => sockets.delete(state));
			ws.on("error", () => sockets.delete(state));
			if (state.authed) {
				ws.send(JSON.stringify({ type: "hello", workspace: privateName(cwd) }));
			}
		});
	});

	// Keepalive: ping every 30s so mobile NATs keep the mapping alive.
	const pingTimer = setInterval(() => {
		for (const socket of sockets) {
			if (socket.ws.readyState === WebSocket.OPEN) socket.ws.ping();
		}
	}, 30_000);

	await new Promise<void>((resolvePromise, rejectPromise) => {
		httpServer.once("error", rejectPromise);
		httpServer.listen(typeof options.port === "string" ? Number(options.port) : (options.port ?? 0), host, () => resolvePromise());
	});
	const address = httpServer.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : Number(options.port ?? 0);

	const issued = pairing.issue();
	const handle: ServeServerHandle = {
		port: boundPort,
		host,
		pairingUri() {
			const displayHost = host === "0.0.0.0" ? (detectLanIps()[0] ?? "<lan-ip>") : host;
			return `zharness://pair?host=${encodeURIComponent(displayHost)}&port=${boundPort}&code=${issued.code}`;
		},
		newPairingCode() {
			const next = pairing.issue();
			console.log(`[serve] new pairing code: ${next.code}`);
			options.onPairingCode?.({ code: next.code, host, port: boundPort, expiresAt: next.expiresAt });
			return { code: next.code, host, port: boundPort, expiresAt: next.expiresAt };
		},
		async stop() {
			clearInterval(pingTimer);
			for (const socket of sockets) socket.ws.close(1001, "server stopping");
			wsServer.close();
			await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
			if (sidecar) {
				await sidecar.stop().catch(() => { /* best-effort */ });
				sidecar = null;
			}
		},
	};

	console.log(`[serve] ZHarness mobile bridge`);
	console.log(`[serve]   workspace : ${cwd}`);
	const lanIps = host === "0.0.0.0" ? detectLanIps() : [];
	const bestIp = lanIps[0] ?? (host === "0.0.0.0" ? undefined : host);
	console.log(`[serve]   ws url    : ws://${bestIp ?? "<this-host>"}:${boundPort}/ws`);
	console.log(`[serve]   pair uri  : ${handle.pairingUri()}   <- 手机端直接粘贴这条`);
	if (host === "0.0.0.0" && lanIps.length === 0) {
		console.log(`[serve]   (未发现可用的局域网 IPv4 —— 手机无法连接。`);
		console.log(`[serve]    请确认电脑与手机在同一 Wi-Fi/网络，运行 ipconfig 查看`);
		console.log(`[serve]    IPv4 地址（形如 192.168.x.x），然后在手机端手动填入)`);
	} else if (lanIps.length > 1) {
		console.log(`[serve]   其他候选 IP: ${lanIps.slice(1).join(", ")}`);
	}
	console.log(`[serve]   pairing code (valid 5 min, single use): ${issued.code}`);
	options.onReady?.({ host, port: boundPort });
	options.onPairingCode?.({ code: issued.code, host, port: boundPort, expiresAt: issued.expiresAt });
	return handle;
}

// ============================================================================
// HTTP surface (discovery + pairing handoff page)
// ============================================================================

function handleHttp(
	req: IncomingMessage,
	res: ServerResponse,
	context: {
		cwd: string;
		pairing: PairingCodeStore;
		sockets: Set<SocketState>;
	},
): void {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	if (req.method !== "GET") {
		res.writeHead(405).end();
		return;
	}
	if (url.pathname === "/health") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ app: "zharness-serve", workspace: privateName(context.cwd), clients: context.sockets.size }));
		return;
	}
	// Human handoff: open this page from the phone's browser to copy the pair
	// URI into the app. Acceptable on a trusted LAN — the code is single-use
	// and also visible on the host console.
	if (url.pathname === "/" || url.pathname === "/pair") {
		const code = context.pairing.current();
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><meta charset="utf-8"><title>ZHarness pairing</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>ZHarness pairing</h1>
<p>Workspace: <code>${privateName(context.cwd)}</code></p>
${code
	? `<p>Pairing code: <strong style="font-size:2rem">${code.code}</strong> (valid 5 minutes, single use)</p>
	   <p>In the ZHarness Android app choose <em>Add server</em> and enter this code along with the host and port ${url.port}.</p>`
	: `<p>No active pairing code. Run <code>zharness serve</code> on the host to issue one.</p>`}
</body>`);
		return;
	}
	res.writeHead(404).end();
}
