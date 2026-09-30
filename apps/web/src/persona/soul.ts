/**
 * SOUL.md parsing — turns the agent identity file into a structured persona
 * the GUI can render as a character card.
 *
 * SOUL.md format (see src/core/main-agent.ts):
 *
 * ```
 * ---
 * description: Soul not yet defined — ...
 * tags: [identity, soul, persistent-agent, memory]
 * ---
 * # Identity
 * ...
 * # Language
 * ...
 * # Values
 * ...
 * # Voice
 * ...
 * ```
 */

export interface PersonaSection {
	heading: string;
	content: string;
}

export interface ParsedSoul {
	/** Frontmatter description (used as the expert title line). */
	description: string | null;
	/** Sections keyed by heading, in file order. */
	sections: PersonaSection[];
	/** Convenience: section content by heading (lowercased), or null. */
	section(name: string): string | null;
	/** True when the file is still the untouched placeholder template. */
	uninitialized: boolean;
}

const NOT_YET_DEFINED = "[NOT YET DEFINED]";

export function parseSoul(content: string | null): ParsedSoul | null {
	if (content === null) return null;

	// Split frontmatter from body.
	let frontmatter = "";
	let body = content;
	if (content.startsWith("---")) {
		const end = content.indexOf("\n---", 3);
		if (end !== -1) {
			frontmatter = content.slice(3, end).trim();
			body = content.slice(end + 4);
		}
	}

	// Parse `description:` from frontmatter.
	let description: string | null = null;
	for (const line of frontmatter.split("\n")) {
		const m = line.match(/^description:\s*(.+)$/);
		if (m) {
			description = m[1].trim();
			break;
		}
	}

	// Split body into `# Heading` sections.
	const sections: PersonaSection[] = [];
	let current: PersonaSection | null = null;
	for (const line of body.split("\n")) {
		const m = line.match(/^#\s+(.+)$/);
		if (m) {
			if (current) sections.push(current);
			current = { heading: m[1].trim(), content: "" };
		} else if (current) {
			current.content += line + "\n";
		}
	}
	if (current) sections.push(current);
	for (const s of sections) s.content = s.content.trim();

	return {
		description,
		sections,
		section(name) {
			const lower = name.toLowerCase();
			const hit = sections.find((s) => s.heading.toLowerCase() === lower);
			return hit ? hit.content : null;
		},
		uninitialized: content.includes(NOT_YET_DEFINED),
	};
}

/**
 * Derive a display name for the agent from the Identity section.
 *
 * Tries, in order: 「名」/ “name” / "name" quoted forms, then the first
 * sentence up to ~16 chars. Falls back to a generic name.
 */
export function deriveAgentName(soul: ParsedSoul | null): string {
	const identity = soul?.section("Identity") ?? null;
	if (identity) {
		const quoted = identity.match(/[「“"]([^」”"]{1,16})[」”"]/);
		if (quoted) return quoted[1];
		// Match a 「名」/ **name** / name pattern at the start of a line.
		const bold = identity.match(/\*\*([^*]{1,16})\*\*/);
		if (bold) return bold[1];
		const firstLine = identity.split(/[。\n.!]/)[0]?.trim();
		if (firstLine && firstLine.length <= 16) return firstLine;
	}
	return "ZHarness";
}

/** Short role line shown under the agent name. */
export function deriveAgentRole(soul: ParsedSoul | null): string {
	// Prefer the frontmatter description (trimmed at an em-dash), else the
	// first meaningful line of Identity. Placeholder text is skipped.
	const desc = soul?.description;
	if (desc && !desc.toLowerCase().includes("not yet defined")) {
		const short = desc.split("—")[0].trim();
		if (short) return short;
	}
	const identity = soul?.section("Identity") ?? "";
	for (const line of identity.split("\n")) {
		const t = line.trim().replace(/^\*\*|\*\*$/g, "").trim();
		if (t && !t.includes(NOT_YET_DEFINED) && t.length <= 40) return t;
	}
	return "智能体专家 · 身份待定义";
}
