/**
 * AgentMessage → 预览视图 的序列化（context_preview RPC 使用）。
 *
 * 关键事实必须如实镜像发送链路（src/core/runtime/ai-client.ts 的 complete）：
 * 只有 user / assistant / toolResult 三种角色会真正进入 provider 请求，
 * 其余角色（compactionSummary / branchSummary / custom / bashExecution）
 * 在投影层存在、发送层被过滤。预览对这两类消息给出不同的
 * sentToLlm / editable / deletable 标注，避免用户编辑一段永远不会
 * 到达模型的文本。
 */

import type { AgentMessage } from "../../core/agent/types.js";

/** 预览用的消息类型分类（决定 UI 着色）。 */
export type ContextMessageKind =
	| "user"
	| "assistant"
	| "toolResult"
	| "compactionSummary"
	| "branchSummary"
	| "custom"
	| "bashExecution";

export interface ContextMessageView {
	/** 源事件 id（压缩摘要注入时为其 COMPACTION_END 事件 id）。 */
	eventId?: string;
	/** 角色分类，UI 按 kind 着色。 */
	kind: ContextMessageKind;
	/** 原始 role 字符串（含 pi-ai 角色）。 */
	role: string;
	/** 展示/编辑用全文。 */
	text: string;
	/** 是否真正进入下一次 LLM 请求（镜像 ai-client 的角色过滤）。 */
	sentToLlm: boolean;
	editable: boolean;
	deletable: boolean;
	/** 不可编辑/不可删除/不发送的原因（UI 提示用）。 */
	note?: string;
	meta?: {
		toolName?: string;
		toolCallNames?: string[];
		isError?: boolean;
		hasImages?: boolean;
		customType?: string;
		tokensBefore?: number;
	};
	charCount: number;
	timestamp?: number;
}

/** 与 ai-client.complete 的过滤保持一致的角色集合。 */
const SENT_ROLES = new Set(["user", "assistant", "toolResult"]);

function blocksToText(content: unknown): { text: string; imageCount: number } {
	if (typeof content === "string") return { text: content, imageCount: 0 };
	if (!Array.isArray(content)) return { text: "", imageCount: 0 };
	const parts: string[] = [];
	let imageCount = 0;
	for (const block of content as { type?: string; text?: string }[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block?.type === "image") {
			imageCount++;
		}
	}
	return { text: parts.join("\n"), imageCount };
}

/** 单条 AgentMessage → ContextMessageView。 */
export function toContextMessageView(message: AgentMessage, eventId?: string): ContextMessageView {
	const role = message.role;
	const kind = (
		role === "user" ||
		role === "assistant" ||
		role === "toolResult" ||
		role === "compactionSummary" ||
		role === "branchSummary" ||
		role === "custom" ||
		role === "bashExecution"
			? role
			: "custom"
	) as ContextMessageKind;

	const sentToLlm = SENT_ROLES.has(role);
	const base: ContextMessageView = {
		eventId,
		kind,
		role,
		text: "",
		sentToLlm,
		editable: false,
		deletable: false,
		charCount: 0,
		timestamp: (message as { timestamp?: number }).timestamp,
	};

	switch (role) {
		case "user": {
			const { text, imageCount } = blocksToText((message as { content: unknown }).content);
			return {
				...base,
				text,
				editable: true,
				deletable: true,
				meta: imageCount > 0 ? { hasImages: true } : undefined,
				charCount: text.length,
			};
		}
		case "assistant": {
			const content = (message as { content: unknown[] }).content ?? [];
			const toolCallNames: string[] = [];
			const parts: string[] = [];
			let imageCount = 0;
			for (const block of content as { type?: string; text?: string; name?: string }[]) {
				if (block?.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				} else if (block?.type === "thinking") {
					// 思考块也是上下文的一部分，展示时单独标注（编辑时会被丢弃）。
					const thinkText = typeof (block as { text?: string }).text === "string" ? (block as { text: string }).text : "";
					if (thinkText) parts.push(`[thinking]\n${thinkText}\n[/thinking]`);
				} else if (block?.type === "toolCall") {
					toolCallNames.push(String(block.name ?? ""));
				} else if (block?.type === "image") {
					imageCount++;
				}
			}
			const text = parts.join("\n");
			const hasToolCalls = toolCallNames.length > 0;
			return {
				...base,
				text,
				editable: true,
				deletable: !hasToolCalls,
				note: hasToolCalls ? "含工具调用块：可编辑文本，但不可删除（删除会破坏 toolCall↔toolResult 配对）" : undefined,
				meta: {
					toolCallNames: toolCallNames.length ? toolCallNames : undefined,
					hasImages: imageCount > 0 || undefined,
				},
				charCount: text.length,
			};
		}
		case "toolResult": {
			const m = message as unknown as {
				content: unknown;
				toolName?: string;
				isError?: boolean;
			};
			const { text, imageCount } = blocksToText(m.content);
			return {
				...base,
				text,
				editable: true,
				deletable: false,
				note: "工具结果：可编辑文本，但不可删除（删除会破坏 toolCall↔toolResult 配对）",
				meta: {
					toolName: m.toolName,
					isError: m.isError || undefined,
					hasImages: imageCount > 0 || undefined,
				},
				charCount: text.length,
			};
		}
		case "compactionSummary": {
			const m = message as unknown as { summary: string; tokensBefore: number };
			return {
				...base,
				text: m.summary ?? "",
				note: "压缩摘要：当前发送链路会过滤该角色，不会到达模型",
				meta: { tokensBefore: m.tokensBefore },
				charCount: (m.summary ?? "").length,
			};
		}
		case "branchSummary": {
			const m = message as unknown as { summary: string };
			return {
				...base,
				text: m.summary ?? "",
				note: "分支摘要：当前发送链路会过滤该角色，不会到达模型",
				charCount: (m.summary ?? "").length,
			};
		}
		case "custom": {
			const m = message as unknown as { customType: string; content: unknown };
			const { text } = blocksToText(m.content);
			return {
				...base,
				text,
				note: "扩展自定义消息：当前发送链路会过滤该角色，不会到达模型",
				meta: { customType: m.customType },
				charCount: text.length,
			};
		}
		case "bashExecution": {
			const m = message as unknown as { command: string; output: string; exitCode: number | undefined };
			const text = `$ ${m.command ?? ""}\n${m.output ?? ""}`;
			return {
				...base,
				text,
				note: "bash 执行记录：当前发送链路会过滤该角色，不会到达模型",
				meta: { toolName: "bash" },
				charCount: text.length,
			};
		}
		default: {
			const { text } = blocksToText((message as { content?: unknown }).content);
			return { ...base, text, charCount: text.length };
		}
	}
}
