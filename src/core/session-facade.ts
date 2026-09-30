/**
 * SessionFacade
 *
 * Lightweight event-sourced session entry point for modes and extensions.
 * It owns no transcript state; conversation data is read from EventStore
 * projections through EventSourcedRuntime.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { EventBase, ImageContent } from "./event-store/types.js";
import type { SubscribeOptions } from "./event-store/store.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionProjection } from "./projection/session-projection.js";
import type { SettingsManager } from "./settings-manager.js";
import { isPersistableThinkingLevel } from "./settings-manager.js";
import type { BuildSystemPromptOptions } from "./system-prompt.js";
import type { ModelConfig, ToolDefinition } from "./runtime/llm-types.js";
import type { RuntimeCompactOptions } from "./runtime/runtime.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";

export interface SessionFacadeConfig {
	runtime: EventSourcedRuntime;
	settingsManager: SettingsManager;
	extensionRunner?: ExtensionRunner;
	modelRegistry?: ModelRegistry;
	resourceLoader?: ResourceLoader;
	disposers?: Array<() => void>;
	/**
	 * Append an extension-authored custom message to the transcript. Used to
	 * deliver `message` results returned from `before_agent_start` handlers.
	 */
	appendCustomMessage?: (
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
	) => void;
	/** Options used to build the current system prompt (informational for extensions). */
	getSystemPromptOptions?: () => BuildSystemPromptOptions | undefined;
}

export type SessionFacadeEventListener = (event: EventBase) => void;

export class SessionFacade {
	readonly runtime: EventSourcedRuntime;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly modelRegistry: ModelRegistry | undefined;
	readonly resourceLoader: ResourceLoader | undefined;
	private readonly appendCustomMessage:
		| ((message: Pick<CustomMessage, "customType" | "content" | "display" | "details">) => void)
		| undefined;
	private readonly getSystemPromptOptions: (() => BuildSystemPromptOptions | undefined) | undefined;
	private disposers: Array<() => void>;
	private disposed = false;

	constructor(config: SessionFacadeConfig) {
		this.runtime = config.runtime;
		this.settingsManager = config.settingsManager;
		this.extensionRunner = config.extensionRunner;
		this.modelRegistry = config.modelRegistry;
		this.resourceLoader = config.resourceLoader;
		this.appendCustomMessage = config.appendCustomMessage;
		this.getSystemPromptOptions = config.getSystemPromptOptions;
		this.disposers = config.disposers ?? [];
	}

	subscribe(listener: SessionFacadeEventListener, options?: SubscribeOptions): () => void {
		return this.runtime.subscribe(listener, options);
	}

	/**
	 * Submit a user prompt and drive one agent turn cycle.
	 *
	 * Before the turn starts, `before_agent_start` is emitted to extensions so
	 * they can append to the system prompt (e.g. skill bootstrap injection) or
	 * contribute custom messages to the transcript.
	 */
	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		// Slash-command dispatch: "/<name> <args>" inputs route to the
		// registered extension command handler instead of the LLM. All modes
		// (TUI, print, RPC/GUI) funnel through prompt(), so this single hook
		// covers them all.
		if (await this.tryExtensionCommand(text)) {
			return;
		}
		const runner = this.extensionRunner;
		if (runner?.hasHandlers("before_agent_start")) {
			// The extension event API models images with the pi-ai ImageContent
			// type; the facade-level type is structurally compatible for pass-through.
			const eventImages = images as unknown as Parameters<
				ExtensionRunner["emitBeforeAgentStart"]
			>[1];
			const result = await runner.emitBeforeAgentStart(
				text,
				eventImages,
				this.runtime.getSystemPrompt(),
				this.getSystemPromptOptions?.() ?? ({} as BuildSystemPromptOptions),
			);
			if (result?.systemPrompt !== undefined) {
				this.runtime.setSystemPrompt(result.systemPrompt);
			}
			for (const message of result?.messages ?? []) {
				this.appendCustomMessage?.(message);
			}
		}
		return this.runtime.prompt(text, images);
	}

	steer(text: string, images?: ImageContent[]): void {
		this.runtime.steer(text, images);
	}

	/**
	 * If `text` is "/<command-name> [args]" and an extension command with that
	 * name is registered, execute its handler and return true (the input is
	 * consumed and never reaches the LLM). The command echo is appended as a
	 * USER_MESSAGE event so event-driven UIs (TUI, GUI) render what was run;
	 * handler output goes through the mode's UI context (notify).
	 */
	private async tryExtensionCommand(text: string): Promise<boolean> {
		const runner = this.extensionRunner;
		if (!runner || !text.startsWith("/") || text.trim() === "/") {
			return false;
		}
		const trimmed = text.trim();
		const spaceIndex = trimmed.search(/\s/);
		const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
		if (!name) {
			return false;
		}
		const command = runner.getCommand(name);
		if (!command) {
			return false;
		}
		const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
		// Echo the command into the transcript (event-driven UIs render this).
		this.runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: text },
		});
		try {
			await command.handler(args, runner.createCommandContext());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.appendCustomMessage?.({
				customType: `command_error:${name}`,
				content: `/${name} failed: ${message}`,
				display: true,
			});
			// Headless modes (no UI context bound) have no other output channel.
			if (!runner.hasUI()) {
				console.error(`/${name} failed: ${message}`);
			}
		}
		return true;
	}

	followUp(text: string, images?: ImageContent[]): void {
		this.runtime.followUp(text, images);
	}

	abort(): void {
		this.runtime.abort();
	}

	compact(options?: RuntimeCompactOptions): void {
		this.runtime.compact(options);
	}

	waitForIdle(): Promise<void> {
		return this.runtime.waitForIdle();
	}

	get isRunning(): boolean {
		return this.runtime.isRunning;
	}

	get signal(): AbortSignal | undefined {
		return this.runtime.signal;
	}

	getProjection(): SessionProjection {
		return this.runtime.getProjection();
	}

	get model(): ModelConfig {
		return this.runtime.getModel();
	}

	set model(model: ModelConfig) {
		this.setModel(model);
	}

	setModel(model: ModelConfig | Model<any>, thinkingLevel?: string): void {
		const modelId = "model_id" in model ? model.model_id : model.id;
		this.runtime.setModel(model.provider, modelId);
		this.persistModel(model.provider, modelId);

		const nextThinkingLevel = thinkingLevel ?? ("thinking_level" in model ? model.thinking_level : undefined);
		if (nextThinkingLevel !== undefined) {
			this.runtime.setThinkingLevel(nextThinkingLevel);
			this.persistThinkingLevel(nextThinkingLevel);
		}
	}

	get thinkingLevel(): string | undefined {
		return this.runtime.getThinkingLevel();
	}

	set thinkingLevel(level: string | undefined) {
		if (level !== undefined) {
			this.runtime.setThinkingLevel(level);
			this.persistThinkingLevel(level);
		}
	}

	/**
	 * Persist the user's model choice as the global default so the next sidecar
	 * launch picks it up. Best-effort: a settings-write error is warned but never
	 * thrown, because the in-memory state has already been updated by
	 * `runtime.setModel` above and we don't want to break the current turn over
	 * a disk-side failure.
	 */
	private persistModel(provider: string, modelId: string): void {
		try {
			this.settingsManager.setDefaultModelAndProvider(provider, modelId);
		} catch (e) {
			console.warn(
				`[zharness] failed to persist model preference (${provider}/${modelId}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	/**
	 * Persist the user's thinking-level choice as the global default. Same
	 * best-effort semantics as {@link persistModel}. The runtime accepts
	 * arbitrary level strings, so values settings.json can't represent are
	 * skipped rather than written back as garbage.
	 */
	private persistThinkingLevel(level: string): void {
		if (!isPersistableThinkingLevel(level)) return;
		try {
			this.settingsManager.setDefaultThinkingLevel(level);
		} catch (e) {
			console.warn(
				`[zharness] failed to persist thinking-level preference (${level}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	get tools(): ToolDefinition[] {
		return this.runtime.getTools();
	}

	set tools(tools: ToolDefinition[]) {
		this.runtime.setTools(tools);
	}

	get systemPrompt(): string {
		return this.runtime.getSystemPrompt();
	}

	set systemPrompt(prompt: string) {
		this.runtime.setSystemPrompt(prompt);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const dispose of this.disposers.splice(0)) {
			dispose();
		}
		this.runtime.dispose();
	}
}