import type { CapturePromptSettings as Settings } from "@cinderdeck/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { CapturePromptPresetSettings } from "./CapturePromptPresetSettings";

export function CapturePromptSettings() {
  const bridge = window.desktopBridge?.capturePrompt;
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = saved !== null && draft !== null && saved.presets !== draft.presets;

  const refresh = async () => {
    if (!bridge) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const settings = await bridge.settings();
      setSaved(settings);
      setDraft(settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not read capture settings.");
    } finally {
      setBusy(false);
    }
  };
  // oxlint-disable-next-line cinderdeck/no-unreasoned-state-sync -- Read the Mac host’s preferences over IPC when this settings page mounts.
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.settings().then(
      (settings) => {
        if (!active) return;
        setSaved(settings);
        setDraft(settings);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : "Could not read capture settings.");
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  const save = async () => {
    if (!bridge || !saved || !draft || !dirty || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const settings = await bridge.settings({ expected: saved, value: draft });
      setSaved(settings);
      setDraft(settings);
      setNotice("Capture settings saved.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save capture settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="capture-prompts" title="Capture prompts">
        {draft ? (
          <div className="px-3 py-3 sm:px-4">
            <CapturePromptPresetSettings
              value={draft.presets}
              disabled={busy}
              onChange={(presets) => setDraft({ ...draft, presets })}
            />
            <div className="mt-4 flex justify-end gap-2">
              {dirty ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDraft(saved);
                    setError("");
                    setNotice("");
                  }}
                >
                  Discard
                </Button>
              ) : null}
              <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
                Save changes
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-3 py-3 sm:px-4">
            <p className="text-sm text-muted-foreground">
              {bridge
                ? error
                  ? "Capture settings are unavailable."
                  : "Loading capture settings…"
                : "Capture prompts are available in the Cinderdeck Mac app."}
            </p>
          </div>
        )}
        {notice || error ? (
          <div className="px-3 py-3 sm:px-4">
            {error ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => void refresh()}>
                  Reload saved values
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
