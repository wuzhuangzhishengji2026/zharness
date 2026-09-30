/**
 * Regression tests: failed compactions must never act as a context boundary.
 *
 * A failed compaction used to be recorded as a COMPACTION_END event with an
 * empty first_kept_event_id (summary = "Compaction failed: …"). Projections
 * treated every COMPACTION_END as "everything before first_kept_event_id was
 * summarized", so the failed marker dropped the ENTIRE conversation before it
 * from every subsequent projection — every conversation in the workspace
 * opened as an empty chat.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { isCompactionBoundary } from "../src/core/event-store/events.js";
import { buildSessionContext } from "../src/core/session-context-builder.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";
import type { SessionEntry } from "../src/core/types/session-types.js";

describe("failed compaction markers", () => {
	const testDir = join(tmpdir(), ".test-zharness-failed-compaction", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function appendTurn(userText: string, agentText: string): void {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: userText } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: agentText }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
	}

	function appendFailedCompaction(): void {
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Compaction failed: Nothing to compact",
				first_kept_event_id: "",
				tokens_before: 0,
			},
		});
	}

	function createDescriptor(): SessionDescriptor {
		return {
			session_id: "sess_test",
			thread_id: "thread_test",
			workspace_id: "test-ws",
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
		};
	}

	function textOf(messages: Array<Record<string, unknown>>): string[] {
		return messages.map((m) => {
			if (typeof m.summary === "string") return m.summary;
			if (typeof m.content === "string") return m.content;
			if (Array.isArray(m.content)) {
				return m.content
					.filter((b) => (b as { type?: string }).type === "text")
					.map((b) => String((b as { text?: string }).text ?? ""))
					.join("\n");
			}
			return "";
		});
	}

	it("isCompactionBoundary distinguishes real boundaries from failure markers", () => {
		expect(
			isCompactionBoundary({ type: "COMPACTION_END", payload: { summary: "s", first_kept_event_id: "evt_1" } }),
		).toBe(true);
		expect(
			isCompactionBoundary({ type: "COMPACTION_END", payload: { summary: "Compaction failed: x", first_kept_event_id: "" } }),
		).toBe(false);
		expect(
			isCompactionBoundary({ type: "COMPACTION_END", payload: { summary: "s" } }),
		).toBe(false);
		expect(isCompactionBoundary({ type: "USER_MESSAGE", payload: {} })).toBe(false);
	});

	it("failed COMPACTION_END must not trim history in buildContext", () => {
		appendTurn("first request", "first response");
		appendFailedCompaction();
		appendTurn("second request", "second response");

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		const texts = textOf(context.messages as unknown as Array<Record<string, unknown>>);
		expect(texts).toEqual(["first request", "first response", "second request", "second response"]);
		expect(context.messages.some((m) => m.role === "compactionSummary")).toBe(false);
	});

	it("events before a later real boundary still respect that boundary", () => {
		appendTurn("first request", "first response");
		appendFailedCompaction();
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "earlier work summarized",
				first_kept_event_id: kept.event_id,
				tokens_before: 9000,
				tokens_after: 1000,
			},
		});
		appendTurn("after compaction", "after compaction response");

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		const texts = textOf(context.messages as unknown as Array<Record<string, unknown>>);
		expect(texts).toEqual(["earlier work summarized", "kept request", "after compaction", "after compaction response"]);
		expect(texts.some((t) => t.includes("first request"))).toBe(false);
	});

	it("buildSessionContext ignores failed compaction entries", () => {
		const ts = new Date().toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: "first request", timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "e2",
				parentId: "e1",
				timestamp: ts,
				summary: "Compaction failed: Nothing to compact",
				firstKeptEntryId: "",
				tokensBefore: 0,
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: ts,
				message: { role: "user", content: "second request", timestamp: Date.now() },
			},
		];

		const context = buildSessionContext(entries);
		const texts = textOf(context.messages as unknown as Array<Record<string, unknown>>);
		expect(texts).toEqual(["first request", "second request"]);
		expect(context.messages.some((m) => m.role === "compactionSummary")).toBe(false);
	});
});
