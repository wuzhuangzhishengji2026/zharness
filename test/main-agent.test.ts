import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	acquireMainLock,
	buildPersonaData,
	ensureMemoryScaffold,
	getMainAgentGuidelines,
	initializeMainAgent,
	isSoulUninitialized,
	loadLongTermMemory,
	loadSoulFile,
} from "../src/core/main-agent.js";
import { APP_NAME, getMainMemoryDir, getMainSoulPath } from "../src/config.js";

describe("main-agent", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `zharness-test-main-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("initializeMainAgent", () => {
		test("scaffolds SOUL.md, _index.md, and user-profile.md on first run and returns true", () => {
			const mainDir = join(tempDir, "main");
			const memoryDir = getMainMemoryDir(mainDir);

			const fresh = initializeMainAgent(mainDir, memoryDir);

			expect(fresh).toBe(true);
			expect(existsSync(getMainSoulPath(mainDir))).toBe(true);
			expect(existsSync(join(memoryDir, "_index.md"))).toBe(true);
			expect(existsSync(join(memoryDir, "user-profile.md"))).toBe(true);
		});

		test("is idempotent — does not overwrite existing files and returns false", () => {
			const mainDir = join(tempDir, "main");
			const memoryDir = getMainMemoryDir(mainDir);

			initializeMainAgent(mainDir, memoryDir);

			// User customizes SOUL.md.
			const soulPath = getMainSoulPath(mainDir);
			writeFileSync(soulPath, "# My custom soul\n\nDo not overwrite me.", "utf-8");

			// User customizes _index.md.
			const indexPath = join(memoryDir, "_index.md");
			writeFileSync(indexPath, "# My custom index\n", "utf-8");

			const fresh = initializeMainAgent(mainDir, memoryDir);

			expect(fresh).toBe(false);
			expect(readFileSync(soulPath, "utf-8")).toBe("# My custom soul\n\nDo not overwrite me.");
			expect(readFileSync(indexPath, "utf-8")).toBe("# My custom index\n");
		});

		test("accepts undefined memoryDir and computes it from mainDir", () => {
			const mainDir = join(tempDir, "main");

			const fresh = initializeMainAgent(mainDir);

			expect(fresh).toBe(true);
			expect(existsSync(join(getMainMemoryDir(mainDir), "_index.md"))).toBe(true);
		});

		test("SOUL.md is a placeholder with [NOT YET DEFINED] markers, not a pre-filled identity", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			const soulContent = readFileSync(getMainSoulPath(mainDir), "utf-8");

			// The default soul must be a placeholder, not a pre-filled identity.
			expect(soulContent).toContain("[NOT YET DEFINED]");
			// Must NOT contain a pre-baked persona name or identity statement.
			expect(soulContent).not.toContain("You are zharness,");
			expect(soulContent).not.toContain("You are Aria,");
			// Should have empty Identity, Language, Values, Voice sections for the user to fill.
			expect(soulContent).toContain("# Identity");
			expect(soulContent).toContain("# Language");
			expect(soulContent).toContain("# Values");
			expect(soulContent).toContain("# Voice");
		});
	});

	describe("loadSoulFile", () => {
		test("returns undefined when SOUL.md is absent", () => {
			const mainDir = join(tempDir, "main");
			mkdirSync(mainDir, { recursive: true });

			expect(loadSoulFile(mainDir)).toBeUndefined();
		});

		test("returns the soul content when present", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			const soul = loadSoulFile(mainDir);

			expect(soul).toBeDefined();
			expect(soul?.path).toBe(getMainSoulPath(mainDir));
			expect(soul?.content).toContain("# Identity");
		});
	});

	describe("isSoulUninitialized", () => {
		test("returns true for the freshly-scaffolded placeholder soul", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			const soul = loadSoulFile(mainDir);

			expect(soul).toBeDefined();
			expect(isSoulUninitialized(soul!.content, APP_NAME)).toBe(true);
		});

		test("returns false once the user has personalized the soul (no more [NOT YET DEFINED])", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			// Simulate the agent / user filling in the placeholder.
			writeFileSync(
				getMainSoulPath(mainDir),
				"---\ndescription: custom\n---\n# Identity\nYou are Nova, a careful reviewer.\n\n# Values\n- Be thorough.\n\n# Voice\nFriendly.\n",
				"utf-8",
			);

			const soul = loadSoulFile(mainDir);

			expect(soul).toBeDefined();
			expect(isSoulUninitialized(soul!.content, APP_NAME)).toBe(false);
		});

		test("returns true if any section still has the [NOT YET DEFINED] marker (partial fill)", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			// User filled Identity but left Values and Voice as placeholder.
			writeFileSync(
				getMainSoulPath(mainDir),
				"---\ndescription: custom\n---\n# Identity\nYou are Nova.\n\n# Values\n[NOT YET DEFINED]\n\n# Voice\n[NOT YET DEFINED]\n",
				"utf-8",
			);

			const soul = loadSoulFile(mainDir);

			expect(soul).toBeDefined();
			expect(isSoulUninitialized(soul!.content, APP_NAME)).toBe(true);
		});
	});

	describe("getMainAgentGuidelines", () => {
		test("includes a strong soul-init invitation when soul is uninitialized", () => {
			const guidelines = getMainAgentGuidelines(join(tempDir, "mem"), {
				soulPath: join(tempDir, "main", "SOUL.md"),
				soulUninitialized: true,
			});

			const invitation = guidelines.find((g) => g.includes("NOT YET DEFINED"));
			expect(invitation).toBeDefined();
			expect(invitation).toContain("SOUL.md");
			expect(invitation).toContain("MUST");
			expect(invitation).toContain("FIRST response");
		});

		test("does NOT include the proactive invitation when soul is already personalized", () => {
			const guidelines = getMainAgentGuidelines(join(tempDir, "mem"), {
				soulPath: join(tempDir, "main", "SOUL.md"),
				soulUninitialized: false,
			});

			expect(guidelines.some((g) => g.includes("NOT YET DEFINED"))).toBe(false);
		});

		test("always includes the 'update soul on user request' guideline when soulPath is given", () => {
			const guidelines = getMainAgentGuidelines(join(tempDir, "mem"), {
				soulPath: join(tempDir, "main", "SOUL.md"),
				soulUninitialized: false,
			});

			expect(guidelines.some((g) => g.includes("update your personality"))).toBe(true);
			expect(guidelines.some((g) => g.includes("SOUL.md"))).toBe(true);
		});

		test("omits soul-specific guidelines when no soulPath is provided (backward compat)", () => {
			const guidelines = getMainAgentGuidelines(join(tempDir, "mem"));

			expect(guidelines.some((g) => g.includes("NOT YET DEFINED"))).toBe(false);
			expect(guidelines.some((g) => g.includes("update your personality"))).toBe(false);
			// Core persistent-agent guidelines are still present.
			expect(guidelines.some((g) => g.includes("persistent agent"))).toBe(true);
		});
	});

	describe("loadLongTermMemory / reconcileIndex", () => {
		test("returns [] when memoryDir does not exist", () => {
			const memoryDir = join(tempDir, "no-such-dir");
			expect(loadLongTermMemory(memoryDir)).toEqual([]);
		});

		test("returns [] when memoryDir exists but _index.md is absent and no memory files exist", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });

			expect(loadLongTermMemory(memoryDir)).toEqual([]);
		});

		test("returns a synthetic-label entry when _index.md is absent but unindexed files exist", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "orphan.md"), "# orphan\n", "utf-8");

			const entries = loadLongTermMemory(memoryDir);

			expect(entries).toHaveLength(1);
			// Path should NOT be a real filesystem path (the index file does not exist).
			expect(entries[0].path).toContain("not yet created");
			expect(entries[0].content).toContain("orphan.md (unindexed)");
		});

		test("does not produce false stale entries from .md mentions in prose", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });
			// Index references user-profile.md (exists) but also mentions
			// README.md inside a description — README.md must NOT be flagged stale.
			writeFileSync(
				join(memoryDir, "_index.md"),
				[
					"# Memory Index",
					"",
					"- user-profile.md — stable facts (see also README.md for project context)",
					"",
				].join("\n"),
				"utf-8",
			);
			writeFileSync(join(memoryDir, "user-profile.md"), "# User Profile\n", "utf-8");

			const entries = loadLongTermMemory(memoryDir);

			expect(entries).toHaveLength(1);
			// README.md appears in the prose (legitimate), but must NOT appear in
			// an auto-generated consistency-check note, and no stale/unindexed
			// notes should be appended at all.
			expect(entries[0].content).not.toContain("stale");
			expect(entries[0].content).not.toContain("unindexed");
			expect(entries[0].content).not.toContain("consistency check");
		});

		test("flags unindexed files present on disk but missing from the index", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "_index.md"), "# Memory Index\n\n- user-profile.md — facts\n", "utf-8");
			writeFileSync(join(memoryDir, "user-profile.md"), "# User Profile\n", "utf-8");
			writeFileSync(join(memoryDir, "secret.md"), "# secret\n", "utf-8");

			const entries = loadLongTermMemory(memoryDir);

			expect(entries[0].content).toContain("secret.md (unindexed)");
			expect(entries[0].content).not.toContain("stale");
		});

		test("flags stale index entries pointing at missing files", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(
				join(memoryDir, "_index.md"),
				"# Memory Index\n\n- gone.md — deleted file\n- user-profile.md — facts\n",
				"utf-8",
			);
			writeFileSync(join(memoryDir, "user-profile.md"), "# User Profile\n", "utf-8");
			// gone.md is NOT created.

			const entries = loadLongTermMemory(memoryDir);

			expect(entries[0].content).toContain("gone.md (stale");
			expect(entries[0].content).not.toContain("unindexed");
		});

		test("supports asterisk bullets as list markers", () => {
			const memoryDir = join(tempDir, "memory");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "_index.md"), "# Memory Index\n\n* user-profile.md — facts\n", "utf-8");
			writeFileSync(join(memoryDir, "user-profile.md"), "# User Profile\n", "utf-8");

			const entries = loadLongTermMemory(memoryDir);

			expect(entries[0].content).not.toContain("unindexed");
			expect(entries[0].content).not.toContain("stale");
		});
	});

	describe("ensureMemoryScaffold", () => {
		test("creates _index.md and user-profile.md when missing", () => {
			const memoryDir = join(tempDir, "mem");

			const result = ensureMemoryScaffold(memoryDir);

			expect(result).toEqual({ indexRestored: true, userProfileRestored: true });
			expect(existsSync(join(memoryDir, "_index.md"))).toBe(true);
			expect(existsSync(join(memoryDir, "user-profile.md"))).toBe(true);
		});

		test("is idempotent — never overwrites existing scaffold files", () => {
			const memoryDir = join(tempDir, "mem");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "_index.md"), "# custom index\n", "utf-8");
			writeFileSync(join(memoryDir, "user-profile.md"), "# custom profile\n", "utf-8");

			const result = ensureMemoryScaffold(memoryDir);

			expect(result).toEqual({ indexRestored: false, userProfileRestored: false });
			expect(readFileSync(join(memoryDir, "_index.md"), "utf-8")).toBe("# custom index\n");
			expect(readFileSync(join(memoryDir, "user-profile.md"), "utf-8")).toBe("# custom profile\n");
		});

		test("self-heals a deleted user-profile.md with an auto-restore note", () => {
			const memoryDir = join(tempDir, "mem");
			ensureMemoryScaffold(memoryDir);
			rmSync(join(memoryDir, "user-profile.md"));

			const result = ensureMemoryScaffold(memoryDir);

			expect(result.userProfileRestored).toBe(true);
			expect(result.indexRestored).toBe(false);
			const restored = readFileSync(join(memoryDir, "user-profile.md"), "utf-8");
			expect(restored).toContain("auto-restored");
			expect(restored).toContain("# User Profile");
		});

		test("omits the auto-restore note on fresh initialization (noteAutoRestore: false)", () => {
			const memoryDir = join(tempDir, "mem");

			const result = ensureMemoryScaffold(memoryDir, { noteAutoRestore: false });

			expect(result.userProfileRestored).toBe(true);
			expect(readFileSync(join(memoryDir, "user-profile.md"), "utf-8")).not.toContain("auto-restored");
		});
	});

	describe("buildPersonaData", () => {
		test("returns the scaffolded persona for a fresh main dir", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);

			const persona = buildPersonaData(mainDir);

			expect(persona.soul.path).toBe(getMainSoulPath(mainDir));
			expect(persona.soul.content).toContain("[NOT YET DEFINED]");
			expect(persona.soul.uninitialized).toBe(true);
			expect(persona.userProfile).not.toBeNull();
			expect(persona.userProfile?.path).toBe(join(getMainMemoryDir(mainDir), "user-profile.md"));
			// user-profile.md must also appear in the memory list; _index.md must not.
			expect(persona.memory.map((m) => m.path)).toContain(persona.userProfile!.path);
			expect(persona.memory.some((m) => m.path.endsWith("_index.md"))).toBe(false);
		});

		test("reports uninitialized=false once the soul is personalized", () => {
			const mainDir = join(tempDir, "main");
			initializeMainAgent(mainDir);
			writeFileSync(getMainSoulPath(mainDir), "# Identity\nYou are Nova.\n", "utf-8");

			const persona = buildPersonaData(mainDir);

			expect(persona.soul.uninitialized).toBe(false);
		});

		test("returns null soul content when SOUL.md is absent", () => {
			const mainDir = join(tempDir, "main");
			mkdirSync(mainDir, { recursive: true });

			const persona = buildPersonaData(mainDir);

			expect(persona.soul.content).toBeNull();
			expect(persona.soul.uninitialized).toBe(false);
		});

		test("excludes non-markdown files from the memory list", () => {
			const mainDir = join(tempDir, "main");
			const memoryDir = getMainMemoryDir(mainDir);
			initializeMainAgent(mainDir, memoryDir);
			writeFileSync(join(memoryDir, "notes.txt"), "not markdown", "utf-8");
			writeFileSync(join(memoryDir, "style.md"), "# style\n", "utf-8");

			const persona = buildPersonaData(mainDir, memoryDir);

			const paths = persona.memory.map((m) => m.path);
			expect(paths.some((p) => p.endsWith("notes.txt"))).toBe(false);
			expect(paths.some((p) => p.endsWith("style.md"))).toBe(true);
		});

		test("userProfile is null when user-profile.md has been deleted", () => {
			const mainDir = join(tempDir, "main");
			const memoryDir = getMainMemoryDir(mainDir);
			initializeMainAgent(mainDir, memoryDir);
			rmSync(join(memoryDir, "user-profile.md"));

			const persona = buildPersonaData(mainDir, memoryDir);

			expect(persona.userProfile).toBeNull();
		});

		test("honours an explicit memoryDir override", () => {
			const mainDir = join(tempDir, "main");
			const memoryDir = join(tempDir, "custom-memory");
			initializeMainAgent(mainDir, memoryDir);

			const persona = buildPersonaData(mainDir, memoryDir);

			expect(persona.userProfile?.path).toBe(join(memoryDir, "user-profile.md"));
			expect(persona.memory.every((m) => m.path.startsWith(memoryDir))).toBe(true);
		});

		test("returns empty memory when the memory dir does not exist", () => {
			const mainDir = join(tempDir, "main");
			mkdirSync(mainDir, { recursive: true });

			const persona = buildPersonaData(mainDir, join(tempDir, "no-such-memory"));

			expect(persona.memory).toEqual([]);
			expect(persona.userProfile).toBeNull();
		});
	});

	describe("acquireMainLock", () => {
		test("acquires a lock on a fresh directory and creates the lock directory", async () => {
			const mainDir = join(tempDir, "main-a");
			const lock = await acquireMainLock(mainDir);
			if (!("release" in lock)) throw new Error(`expected a lock, got: ${JSON.stringify(lock)}`);
			// proper-lockfile creates a <target>.lock directory next to the target.
			expect(existsSync(join(mainDir, "main-agent.lock"))).toBe(true);

			lock.release();
			expect(existsSync(join(mainDir, "main-agent.lock"))).toBe(false);
		});

		test("reports contention when the lock is held by another live instance", async () => {
			const mainDir = join(tempDir, "main-b");
			const first = await acquireMainLock(mainDir);
			if (!("release" in first)) throw new Error(`expected a lock, got: ${JSON.stringify(first)}`);

			// A second acquire while the first is still held fails (ELOCKED),
			// reported as {kind:"contended"}. lockRetries:0 skips the wait-out-
			// the-stale-window retry loop so the test stays fast.
			const second = await acquireMainLock(mainDir, { lockRetries: 0 });
			expect(second).toEqual({
				kind: "contended",
				message:
					"Another main agent instance is already running. Use --main-dir to use a different directory, or stop the other instance.",
			});

			first.release();
		});

		test("reclaims a stale lock whose mtime is older than the stale window", async () => {
			const mainDir = join(tempDir, "main-c");
			mkdirSync(mainDir, { recursive: true });
			// Simulate a crashed previous owner: create the lock directory proper-
			// lockfile would have made, then age its mtime past the stale window
			// (15s) so the next acquire reclaims it.
			const lockDir = join(mainDir, "main-agent.lock");
			mkdirSync(lockDir, { recursive: true });
			const old = Math.floor(Date.now() / 1000) - 30;
			utimesSync(lockDir, old, old);

			const lock = await acquireMainLock(mainDir);
			if (!("release" in lock)) throw new Error(`expected a lock, got: ${JSON.stringify(lock)}`);
			lock.release();
		});

		test("removes a legacy PID-based .lock file when acquiring", async () => {
			const mainDir = join(tempDir, "main-d");
			mkdirSync(mainDir, { recursive: true });
			// Older versions wrote a .lock *file* containing the owner PID. The new
			// implementation should clean it up on acquire (best-effort migration).
			writeFileSync(join(mainDir, ".lock"), String(999_999), "utf-8");

			const lock = await acquireMainLock(mainDir);
			if (!("release" in lock)) throw new Error(`expected a lock, got: ${JSON.stringify(lock)}`);
			expect(existsSync(join(mainDir, ".lock"))).toBe(false);

			lock.release();
		});
	});
});
