/**
 * Tests for the serve mode bridge (packages/serve/server.ts).
 *
 * Uses a fake sidecar CLI that mimics `--mode rpc` JSONL framing so the
 * bridge's spawn/command/event relay is exercised end-to-end over real
 * sockets, without any model or agent core involvement.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { runServeServer, type ServeServerHandle } from "../packages/serve/server.js";

// ============================================================================
// Fake sidecar: JSONL in → JSONL out, mimicking packages/rpc/rpc-mode.ts
// ============================================================================

const FAKE_SIDECAR = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "get_state") {
    write({ id: cmd.id, type: "response", command: "get_state", success: true,
      data: { sessionId: "sess-1", isRunning: false, model: { provider: "p", modelId: "m" } } });
  } else if (cmd.type === "get_events") {
    const since = typeof cmd.sinceSequence === "number" ? cmd.sinceSequence : 0;
    const all = [
      { event_id: "evt-1", type: "USER_MESSAGE", timestamp: 100, sequence: 1 },
      { event_id: "evt-2", type: "ASSISTANT_MESSAGE", timestamp: 200, sequence: 2 },
      { event_id: "evt-3", type: "TOOL_CALL", timestamp: 300, sequence: 3 },
    ];
    const events = all.filter((e) => e.sequence > since).slice(-(cmd.limit ?? 1000));
    write({ id: cmd.id, type: "response", command: "get_events", success: true, data: { events } });
  } else {
    write({ id: cmd.id, type: "response", command: cmd.type, success: true });
  }
  write({ type: "AGENT_START" });
});
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
`;

/**
 * Frame source with a persistent receive buffer. Frames arriving between
 * reads are queued, never dropped (mimics OkHttp's delivery queue).
 */
class FrameSource {
	readonly ws: WebSocket;
	private readonly queue: Array<Record<string, unknown>> = [];
	private waiters: Array<{ resolve: (frame: Record<string, unknown>) => void }> = [];

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on("message", (data) => this.push(JSON.parse(String(data))));
	}

	private push(frame: Record<string, unknown>): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(frame);
		else this.queue.push(frame);
	}

	/** Connect and return once open; the collector is attached from birth. */
	async open(): Promise<this> {
		await once(this.ws, "open");
		return this;
	}

	async next(timeoutMs = 5000): Promise<Record<string, unknown>> {
		const buffered = this.queue.shift();
		if (buffered) return buffered;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.resolve !== wrappedResolve);
				reject(new Error("timed out waiting for frame"));
			}, timeoutMs);
			const wrappedResolve = (frame: Record<string, unknown>) => {
				clearTimeout(timer);
				resolve(frame);
			};
			this.waiters.push({ resolve: wrappedResolve });
		});
	}
}

function socketUrl(handle: ServeServerHandle, query = ""): string {
	return `ws://127.0.0.1:${handle.port}/ws${query}`;
}

async function sendAwait(
	source: FrameSource,
	frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const id = `t-${Math.random().toString(36).slice(2)}`;
	source.ws.send(JSON.stringify({ ...frame, id }));
	// Skip unrelated frames (events, hellos) until the matching response.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const response = await source.next();
		if (response.id === id) return response;
	}
	throw new Error(`timed out waiting for response to ${String(frame.type)}`);
}

describe("serve mode bridge", () => {
	let dir: string;
	let sidecarPath: string;
	let handle: ServeServerHandle;
	let pairingCode: string;
	const disposers: Array<() => Promise<void> | void> = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "zharness-serve-test-"));
		sidecarPath = join(dir, "fake-sidecar.mjs");
		writeFileSync(sidecarPath, FAKE_SIDECAR, "utf8");
		handle = await runServeServer({
			cwd: dir,
			host: "127.0.0.1",
			agentDir: dir,
			cliPath: sidecarPath,
			onPairingCode: (info) => {
				pairingCode = info.code;
			},
		});
		disposers.push(() => handle.stop());
	}, 20000);

	afterAll(async () => {
		for (const dispose of disposers.reverse()) {
			await dispose();
		}
		rmSync(dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		// Each test gets a fresh pairing code since codes are single-use.
		pairingCode = handle.newPairingCode().code;
	});

	it("refuses agent commands on unauthenticated sockets", async () => {
		const source = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source.ws.close());
		const response = await sendAwait(source, { type: "get_state" });
		expect(response.success).toBe(false);
		expect(String(response.error)).toMatch(/unauthorized/);
	});

	it("pairs with a valid code and rejects reuse of the same code", async () => {
		const source = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source.ws.close());

		const ok = await sendAwait(source, { type: "pair.claim", code: pairingCode, deviceName: "pixel-test" });
		expect(ok.success).toBe(true);
		const token = (ok.data as { token: string }).token;
		expect(token).toMatch(/^zh_/);

		// Already-authenticated socket cannot claim again.
		const again = await sendAwait(source, { type: "pair.claim", code: "000000" });
		expect(again.success).toBe(false);

		// Fresh socket cannot reuse the consumed code.
		const source2 = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source2.ws.close());
		const reuse = await sendAwait(source2, { type: "pair.claim", code: pairingCode });
		expect(reuse.success).toBe(false);
	});

	it("persists device tokens and authenticates reconnects via ?token=", async () => {
		const devicesPath = join(dir, "serve", "devices.json");
		expect(existsSync(devicesPath)).toBe(true);
		const stored = JSON.parse(readFileSync(devicesPath, "utf8"));
		expect(stored.devices.length).toBeGreaterThan(0);
		// Tokens are stored hashed — the plaintext must not appear on disk.
		expect(JSON.stringify(stored)).not.toContain("zh_");
		expect(stored.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

		// Claim a fresh token, then reconnect with it via ?token=.
		const claimSource = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => claimSource.ws.close());
		const code = handle.newPairingCode().code;
		const claimed = await sendAwait(claimSource, { type: "pair.claim", code, deviceName: "reconnect-test" });
		const realToken = (claimed.data as { token: string }).token;

		// Hello arrives immediately on open; FrameSource buffers from birth.
		const source = await new FrameSource(socketUrl(handle, `?token=${encodeURIComponent(realToken)}`)).open();
		disposers.push(() => source.ws.close());
		const hello = await source.next();
		expect(hello.type).toBe("hello");

		const state = await sendAwait(source, { type: "get_state" });
		expect(state.success).toBe(true);
		expect((state.data as { sessionId: string }).sessionId).toBe("sess-1");
	});

	it("relays sidecar events to authenticated clients", async () => {
		const source = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source.ws.close());
		const code = handle.newPairingCode().code;
		const claimed = await sendAwait(source, { type: "pair.claim", code, deviceName: "events-test" });
		expect(claimed.success).toBe(true);

		// Trigger a command; the fake sidecar emits AGENT_START (as an event
		// frame) after every command. Skip the response, await the event.
		source.ws.send(JSON.stringify({ type: "get_state", id: "evt-probe" }));
		const deadline = Date.now() + 5000;
		let sawEvent = false;
		while (Date.now() < deadline && !sawEvent) {
			const frame = await source.next();
			if (frame.type === "event") {
				expect((frame.event as { type: string }).type).toBe("AGENT_START");
				sawEvent = true;
			}
		}
		expect(sawEvent).toBe(true);
	});

	it("events.resync filters by sinceSequence and reports the cursor", async () => {
		const source = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source.ws.close());
		const code = handle.newPairingCode().code;
		await sendAwait(source, { type: "pair.claim", code, deviceName: "resync-test" });

		const full = await sendAwait(source, { type: "events.resync" });
		expect(full.success).toBe(true);
		const fullData = full.data as { events: Array<{ sequence: number }>; complete: boolean; cursor: number };
		expect(fullData.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
		expect(fullData.complete).toBe(true);
		expect(fullData.cursor).toBe(3);

		const incremental = await sendAwait(source, { type: "events.resync", sinceSequence: 2 });
		const incData = incremental.data as { events: Array<{ sequence: number }>; complete: boolean; cursor: number };
		expect(incData.events.map((e) => e.sequence)).toEqual([3]);
		expect(incData.complete).toBe(true);
		expect(incData.cursor).toBe(3);
	});

	it("answers ping on unauthenticated sockets and 404s unknown http paths", async () => {
		const source = await new FrameSource(socketUrl(handle)).open();
		disposers.push(() => source.ws.close());
		source.ws.send(JSON.stringify({ type: "ping" }));
		const pong = await source.next();
		expect(pong.type).toBe("pong");

		const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
		expect(res.status).toBe(404);
		const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
		const healthBody = (await health.json()) as { app: string };
		expect(healthBody.app).toBe("zharness-serve");
	});
});
