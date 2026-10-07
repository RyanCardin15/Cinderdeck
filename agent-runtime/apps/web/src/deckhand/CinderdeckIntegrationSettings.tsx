import type { EnvironmentId } from "@cinderdeck/contracts";
import { SettingsSection } from "../components/settings/settingsLayout";
import { FoldedSettingsSection } from "../components/settings/FoldedSettingsSection";
import { AgentAccessSettings } from "./AgentAccessSettings";
import { CinderdeckConnectionPanel } from "./CinderdeckConnectionPanel";
import { OwnershipTransitionPanel } from "./OwnershipTransitionPanel";

/** Every native integration action follows the computer selected in settings. */
export function CinderdeckIntegrationSettings({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  return (
    <div className="space-y-5">
      <SettingsSection id="cinderdeck" title="Cinderdeck" variant="plain">
        <CinderdeckConnectionPanel
          key={environmentId ?? "offline"}
          initialEnvironmentId={environmentId}
          variant="settings"
        />
      </SettingsSection>
      <AgentAccessSettings key={environmentId ?? "offline"} environmentId={environmentId} />
      <FoldedSettingsSection
        id="workspace-ownership"
        title="Worktree management"
        summary="Adopt a worktree or release a lane"
      >
        <OwnershipTransitionPanel
          key={environmentId ?? "offline"}
          environmentId={environmentId}
          embedded
        />
      </FoldedSettingsSection>
    </div>
  );
}
