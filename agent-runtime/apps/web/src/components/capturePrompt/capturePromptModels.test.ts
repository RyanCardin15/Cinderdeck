import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@cinderdeck/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cinderdeck/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { resolveCapturePromptModels } from "./capturePromptModels";

function harness(id: string, driver: string, slugs: readonly string[]) {
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T00:00:00.000Z",
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([snapshot])[0]!;
}

describe("capture prompt routing", () => {
  const codex = harness("codex_personal", "codex", ["gpt-6-astra", "gpt-6-sol"]);
  const claude = harness("claude_team", "claudeAgent", ["claude-sonnet-4-6"]);
  const projectDefault: ModelSelection = {
    instanceId: codex.instanceId,
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "high" }],
  };

  it("sends the selected model on its own harness without borrowing traits", () => {
    const result = resolveCapturePromptModels({
      provider: codex,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectDefault,
      rememberedModel: "gpt-6-sol",
    });
    expect(result.options.map((entry) => entry.slug)).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    expect(result.selection).toEqual({ instanceId: codex.instanceId, model: "gpt-6-sol" });

    const switched = resolveCapturePromptModels({
      provider: claude,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectDefault,
      rememberedModel: "gpt-6-sol",
    });
    expect(switched.options.map((entry) => entry.slug)).toEqual(["claude-sonnet-4-6"]);
    expect(switched.selection).toEqual({
      instanceId: claude.instanceId,
      model: "claude-sonnet-4-6",
    });
  });

  it("falls back to project defaults when a remembered model disappears", () => {
    const result = resolveCapturePromptModels({
      provider: codex,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectDefault,
      rememberedModel: "gpt-6-retired",
    });
    expect(result.selection).toEqual(projectDefault);
  });

  it("preserves an explicit harness default when there is no published model list", () => {
    const provider = harness("cursor_local", "cursor", []);
    const result = resolveCapturePromptModels({
      provider,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectDefault: null,
      rememberedModel: null,
    });
    expect(result.options.map((entry) => entry.name)).toEqual(["Harness default"]);
    expect(result.selection).toEqual({ instanceId: provider.instanceId, model: "auto" });
  });
});
