/**
 * TUI wizard for adding a custom OpenAI-compatible provider.
 *
 * Four steps:
 *   1. Provider name  (e.g. `volcano-ark`) — used as the model picker id
 *   2. Base URL       (e.g. `https://ark.cn-beijing.volces.com/api/v3`)
 *   3. API key        (optional — leave empty to fall back to env vars)
 *   4. Model ids      (comma-separated — e.g. `ep-abc, ep-def`)
 *
 * On the last step, writes `~/.zharness/agent/models.json` via the shared
 * `mergeCustomProvider` helper and triggers `modelRegistry.refresh()` so the
 * new model shows up in the picker on next open. Cancels are no-ops (nothing
 * is written until the final step).
 */

import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Text,
} from "@earendil-works/pi-tui";
import {
	fetchOpenAIModels,
	mergeCustomProvider,
} from "../../../src/core/models-json.js";
import type { ModelRegistry } from "../../../src/core/model-registry.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

type Step = "name" | "baseUrl" | "apiKey" | "models";

interface StepDef {
	step: Step;
	title: string;
	prompt: string;
	hint: string;
	required: boolean;
}

const STEPS: StepDef[] = [
	{
		step: "name",
		title: "Add OpenAI-compatible provider (1/4)",
		prompt: "Provider name:",
		hint: "Letters, digits, '-' and '_' only. Becomes the model picker id.",
		required: true,
	},
	{
		step: "baseUrl",
		title: "Add OpenAI-compatible provider (2/4)",
		prompt: "Base URL:",
		hint: "Must start with http:// or https://. e.g. https://ark.cn-beijing.volces.com/api/v3",
		required: true,
	},
	{
		step: "apiKey",
		title: "Add OpenAI-compatible provider (3/4)",
		prompt: "API key (optional):",
		hint: "Leave empty to use env vars (e.g. VOLCANO_API_KEY).",
		required: false,
	},
	{
		step: "models",
		title: "Add OpenAI-compatible provider (4/4)",
		prompt: "Model ids (comma-separated):",
		hint: "Press 'f' before Enter to auto-fetch from {baseUrl}/models.",
		required: true,
	},
];

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export class AddCustomProviderComponent extends Container implements Focusable {
	private input: Input;
	private modelRegistry: ModelRegistry;
	private onComplete: (success: boolean, message?: string) => void;
	private stepIndex = 0;
	private values: Partial<Record<Step, string>> = {};
	private error: Text | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(modelRegistry: ModelRegistry, onComplete: (success: boolean, message?: string) => void) {
		super();
		this.modelRegistry = modelRegistry;
		this.onComplete = onComplete;
		this.input = new Input();
		this.renderForStep();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onComplete(false, "Cancelled");
			return;
		}

		const current = STEPS[this.stepIndex];

		// 'f' shortcut on the models step tries to auto-fetch from /models.
		if (current.step === "models" && keyData === "f") {
			void this.tryFetch();
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			void this.advance();
			return;
		}

		this.input.handleInput(keyData);
	}

	private async tryFetch(): Promise<void> {
		const baseUrl = (this.values.baseUrl ?? "").trim();
		const apiKey = (this.values.apiKey ?? "").trim() || null;
		if (!baseUrl) {
			this.setError("Set the base URL first.");
			return;
		}
		this.setError("Fetching model list...");
		const models = await fetchOpenAIModels(baseUrl, apiKey);
		if (models.length === 0) {
			this.setError("Could not fetch models. Type ids manually below.");
			return;
		}
		this.input.setValue(models.map((m) => m.id).join(", "));
		this.setError(undefined);
	}

	private setError(message: string | undefined): void {
		this.error = undefined;
		this.renderForStep(message);
	}

	private async advance(): Promise<void> {
		const current = STEPS[this.stepIndex];
		const value = this.input.getValue().trim();

		if (current.required && !value) {
			this.setError(`${current.prompt.replace(":", "")} cannot be empty.`);
			return;
		}

		if (current.step === "name" && !NAME_REGEX.test(value)) {
			this.setError("Use letters, digits, '-' or '_' only (no spaces).");
			return;
		}

		if (current.step === "baseUrl" && !/^https?:\/\//.test(value)) {
			this.setError("URL must start with http:// or https://");
			return;
		}

		if (current.step === "models") {
			const ids = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (ids.length === 0) {
				this.setError("At least one model id is required.");
				return;
			}
			await this.save(ids);
			return;
		}

		this.values[current.step] = value;
		this.stepIndex++;
		this.input.setValue("");
		this.renderForStep();
	}

	private async save(modelIds: string[]): Promise<void> {
		const name = this.values.name!.trim();
		const baseUrl = this.values.baseUrl!.trim();
		const apiKey = (this.values.apiKey ?? "").trim() || null;

		this.renderForStep("Saving...");

		try {
			await mergeCustomProvider({ name, baseUrl, apiKey, modelIds });
			this.modelRegistry.refresh();
			this.onComplete(true, `Provider '${name}' added with ${modelIds.length} model(s).`);
		} catch (e) {
			this.renderForStep(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Rebuild the children in the canonical order. Cheaper than tracking each
	 * child separately and avoids the need for `insertBefore`-style APIs.
	 */
	private renderForStep(errorMsg?: string): void {
		this.clear();
		this.error = undefined;

		const current = STEPS[this.stepIndex];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", current.title), 1, 0));
		this.addChild(new Text(theme.fg("text", current.prompt), 1, 0));
		this.addChild(this.input);
		this.addChild(new Text(theme.fg("muted", current.hint), 1, 0));

		if (errorMsg) {
			this.error = new Text(theme.fg("warning", errorMsg), 1, 0);
			this.addChild(this.error);
		}

		this.addChild(
			new Text(
				`${keyHint("tui.select.confirm", "next")}  ${keyHint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}
}
