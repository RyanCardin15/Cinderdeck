import { createFileRoute } from "@tanstack/react-router";
import { ExternalAppsSettings } from "../components/settings/ExternalAppsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

export const Route = createFileRoute("/settings/external-apps")({
  component: () => (
    <SettingsPageContainer>
      <ExternalAppsSettings />
    </SettingsPageContainer>
  ),
});
