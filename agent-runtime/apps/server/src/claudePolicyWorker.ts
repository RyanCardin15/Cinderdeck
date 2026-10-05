import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/** Runs in the provider's environment so SDK policy caches cannot cross accounts. */
export async function runClaudePolicyWorker(): Promise<void> {
  const settings = await resolveSettings({ cwd: process.cwd() });
  process.stdout.write(
    String(settings.effective.permissions?.disableBypassPermissionsMode === "disable"),
  );
}
