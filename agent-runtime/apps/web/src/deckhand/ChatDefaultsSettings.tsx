import { useUpdateClientSettings } from "../hooks/useSettings";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { useChatDefaultsStore } from "./chatDefaults";

export function ChatDefaultsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const preferences = useChatDefaultsStore((state) => state.preferences[environmentId]);
  const setPreferences = useChatDefaultsStore((state) => state.setPreferences);
  const updateClientSettings = useUpdateClientSettings();
  const remember = preferences?.rememberModes ?? true;
  const interactionMode = preferences?.interactionMode ?? "default";
  return (
    <>
      <SettingsRow
        id="chat-mode-memory"
        title="Remember chat modes"
        description="New chats in Agents use the last permissions and Plan or Agent mode selected on this device for this machine. Turn off to use the configured defaults. A pinned model takes priority; Automatic remembers the last provider, model and reasoning effort."
        control={
          <Switch
            checked={remember}
            onCheckedChange={(rememberModes) => setPreferences(environmentId, { rememberModes })}
            aria-label="Remember chat modes"
          />
        }
      />
      <SettingsRow
        id="default-chat-mode"
        title="Default chat mode"
        description="Used when mode memory is off or no previous choice exists. The selected provider must support Plan mode. Permissions use the default above."
        control={
          <Select
            value={interactionMode}
            onValueChange={(value) => {
              if (value === "plan" || value === "default") {
                setPreferences(environmentId, { interactionMode: value });
                if (value === "plan") void updateClientSettings({ planModeEnabled: true });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Default chat mode">
              <SelectValue>{interactionMode === "plan" ? "Plan" : "Agent"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="default">Agent</SelectItem>
              <SelectItem value="plan">Plan</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}
