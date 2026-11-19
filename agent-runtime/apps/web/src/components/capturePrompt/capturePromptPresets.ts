export interface CapturePromptPreset {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
}

export interface CapturePromptPresets {
  readonly presets: readonly CapturePromptPreset[];
  readonly defaultID?: string;
}

export function readCapturePromptPresets(value: unknown): CapturePromptPresets {
  if (typeof value !== "string") return { presets: [] };
  try {
    const parsed = JSON.parse(value) as CapturePromptPresets;
    return {
      presets: Array.isArray(parsed.presets) ? parsed.presets : [],
      ...(typeof parsed.defaultID === "string" ? { defaultID: parsed.defaultID } : {}),
    };
  } catch {
    return { presets: [] };
  }
}
