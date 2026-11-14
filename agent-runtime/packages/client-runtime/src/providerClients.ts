import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@cinderdeck/contracts";
import { acpRegistryClient } from "@cinderdeck/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@cinderdeck/provider-core/client";
import { modelShortName } from "@cinderdeck/provider-core/modelShortName";
import { cursorClient } from "@cinderdeck/provider-cursor/client";
import { fxClient } from "@cinderdeck/provider-fx/client";
import { grokClient } from "@cinderdeck/provider-grok/client";
import { kiroClient } from "@cinderdeck/provider-kiro/client";
import { museClient } from "@cinderdeck/provider-muse/client";
import { openCodeClient } from "@cinderdeck/provider-opencode/client";
import { piClient } from "@cinderdeck/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  kiroClient,
  museClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
