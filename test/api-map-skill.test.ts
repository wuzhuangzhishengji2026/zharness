import { readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.js";

// The bundled api-map skill ships with the repo and is preinstalled at
// rpc-mode startup (see ensureBundledSkillsInstalled). This test guards the
// bundled file itself: valid frontmatter, name matching its directory, and
// coverage of the spec's two load-bearing concepts.
const apiMapSkillDir = resolve(__dirname, "../src/builtin-skills/api-map");

describe("builtin api-map skill", () => {
	it("loads with valid frontmatter and no diagnostics", () => {
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: apiMapSkillDir,
			source: "builtin-skills",
		});

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("api-map");
		expect(skills[0].description.trim().length).toBeGreaterThan(0);
		expect(diagnostics).toHaveLength(0);
	});

	it("documents the envelope, relates and the llms.txt entry point", () => {
		const raw = readFileSync(join(apiMapSkillDir, "SKILL.md"), "utf8");
		expect(raw).toContain("api/llms.txt");
		expect(raw).toContain('"relates"');
		expect(raw).toContain('"data"');
		expect(raw).toContain('"error"');
		expect(raw).toContain("github.com/tomsun28/agentic-api-spec");
	});
});
