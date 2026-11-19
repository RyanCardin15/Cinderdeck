import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { randomUUID } from "../../lib/utils";
import { readCapturePromptPresets, type CapturePromptPresets } from "./capturePromptPresets";

export function CapturePromptPresetSettings({
  value,
  disabled,
  onChange,
}: {
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const preferences = readCapturePromptPresets(value);
  const [expanded, setExpanded] = useState<string | null>(null);
  const update = (next: CapturePromptPresets) => onChange(JSON.stringify(next));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Prompt presets</h3>
          <p className="text-xs text-muted-foreground">
            Insert a saved prompt when you ask about a capture.
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || preferences.presets.length >= 6}
          onClick={() => {
            const id = randomUUID();
            update({
              ...preferences,
              presets: [...preferences.presets, { id, title: "", prompt: "" }],
            });
            setExpanded(id);
          }}
        >
          <PlusIcon /> Add preset
        </Button>
      </div>
      <div className="divide-y overflow-hidden rounded-lg border">
        {preferences.presets.map((preset, index) => (
          <div key={preset.id}>
            <button
              type="button"
              aria-expanded={expanded === preset.id}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
              onClick={() => setExpanded(expanded === preset.id ? null : preset.id)}
            >
              <span className="truncate">{preset.title || "New preset"}</span>
              {preferences.defaultID === preset.id ? (
                <span className="text-xs text-muted-foreground">Default</span>
              ) : null}
            </button>
            {expanded === preset.id ? (
              <div className="grid gap-2 px-3 pb-3">
                <Input
                  aria-label={`Preset ${index + 1} name`}
                  placeholder="Preset name"
                  maxLength={32}
                  value={preset.title}
                  disabled={disabled}
                  onChange={(event) =>
                    update({
                      ...preferences,
                      presets: preferences.presets.map((entry) =>
                        entry.id === preset.id ? { ...entry, title: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Textarea
                  aria-label={`Preset ${index + 1} prompt`}
                  placeholder="Prompt text"
                  rows={3}
                  maxLength={600}
                  value={preset.prompt}
                  disabled={disabled}
                  onChange={(event) =>
                    update({
                      ...preferences,
                      presets: preferences.presets.map((entry) =>
                        entry.id === preset.id ? { ...entry, prompt: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  className="justify-self-start"
                  onClick={() =>
                    update({
                      presets: preferences.presets.filter((entry) => entry.id !== preset.id),
                      ...(preferences.defaultID && preferences.defaultID !== preset.id
                        ? { defaultID: preferences.defaultID }
                        : {}),
                    })
                  }
                >
                  <Trash2Icon /> Remove preset
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {preferences.presets.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No saved presets.</p>
        ) : null}
      </div>
      {preferences.presets.length > 0 ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Default prompt
          <select
            className="max-w-full rounded-md border bg-background px-2 py-1 text-sm"
            value={preferences.defaultID ?? ""}
            disabled={disabled}
            onChange={(event) =>
              update({
                presets: preferences.presets,
                ...(event.target.value ? { defaultID: event.target.value } : {}),
              })
            }
          >
            <option value="">Start with an empty prompt</option>
            {preferences.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.title || "New preset"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
