// @effect-diagnostics globalTimers:off -- Settings round trips use the native process pipe.
import type { CapturePromptSettings, CapturePromptSettingsUpdate } from "@cinderdeck/contracts";

function isSettings(value: unknown): value is CapturePromptSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    "compact" in value &&
    typeof value.compact === "boolean" &&
    "presets" in value &&
    typeof value.presets === "string" &&
    Buffer.byteLength(value.presets) <= 5_000 &&
    Object.keys(value).length === 2
  );
}

export function isCapturePromptSettingsUpdate(
  value: unknown,
): value is CapturePromptSettingsUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    "expected" in value &&
    isSettings(value.expected) &&
    "value" in value &&
    isSettings(value.value) &&
    Object.keys(value).length === 2
  );
}

export class CapturePromptSettingsRequests {
  private readonly pending = new Map<string, (settings: unknown, error?: string) => void>();

  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.write = write;
  }

  request(update?: CapturePromptSettingsUpdate): Promise<CapturePromptSettings> {
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- Correlation is local to the inherited pipe.
    const requestID = crypto.randomUUID();
    const line = JSON.stringify({ requestID, update });
    if (Buffer.byteLength(line) > 16_384)
      return Promise.reject(
        new Error("Capture settings are too large. Shorten the saved prompts."),
      );
    if (this.pending.size >= 4)
      return Promise.reject(new Error("Capture settings are busy. Try again shortly."));
    return new Promise((resolve, reject) => {
      const finish = (settings: unknown, error?: string) => {
        clearTimeout(timer);
        this.pending.delete(requestID);
        if (isSettings(settings) && error === undefined) resolve(settings);
        else reject(new Error(error ?? "Cinderdeck returned invalid capture settings."));
      };
      const timer = setTimeout(
        () => finish(null, "Cinderdeck could not confirm the capture settings."),
        10_000,
      );
      this.pending.set(requestID, finish);
      try {
        this.write("CINDERDECK_CAPTURE_PROMPT_SETTINGS " + line + "\n");
      } catch {
        finish(null, "The native capture settings connection closed.");
      }
    });
  }

  receive(value: Record<string, unknown>) {
    if (typeof value.requestID !== "string") return;
    this.pending.get(value.requestID.toLowerCase())?.(
      value.settings,
      typeof value.error === "string" ? value.error : undefined,
    );
  }

  close() {
    for (const finish of this.pending.values())
      finish(null, "The native capture settings connection closed.");
  }
}
