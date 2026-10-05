import { useState } from "react";
import { AppWindowIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  resolveExternalAppProfiles,
  type ExternalAppProfile,
} from "@cinderdeck/contracts/deckhand/externalAppPreferences";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useDisconnectExternalApps } from "../../deckhand/externalAppSessions";
import { randomUUID } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";

const excelSetup = "defaults write com.microsoft.Excel OfficeWebAddinDeveloperExtras -bool true";

export function ExternalAppsSettings() {
  const settings = useClientSettings();
  const update = useUpdateClientSettings();
  const disconnect = useDisconnectExternalApps();
  const profiles = resolveExternalAppProfiles(settings.externalAppProfiles);
  const [message, setMessage] = useState("");
  function save(id: string, patch: Partial<ExternalAppProfile>) {
    update({
      externalAppProfiles: profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    });
    if (patch.enabled === false) void disconnect((binding) => binding.profileId === id);
  }
  return (
    <div className="space-y-6">
      <div className="px-3 sm:px-4">
        <p className="text-sm text-muted-foreground">
          Choose which Mac apps appear in your session’s side panel. Each app opens alongside the
          conversation, like a browser.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          These preferences apply to this viewer. The session’s connection determines which Mac
          supplies the windows.
        </p>
      </div>
      <SettingsSection
        title="External apps"
        id="external-apps"
        headerAction={
          <Button
            size="sm"
            variant="outline"
            disabled={profiles.length >= 16}
            onClick={() =>
              update({
                externalAppProfiles: [
                  ...profiles,
                  {
                    id: randomUUID(),
                    name: "My Mac app",
                    enabled: true,
                    applicationFilter: "",
                    includeInspector: true,
                    inspectorFilter: "Web Inspector",
                  },
                ],
              })
            }
          >
            <PlusIcon /> Add Mac app
          </Button>
        }
      >
        <div className="space-y-4">
          {profiles.map((profile) => (
            <SettingsGroup key={profile.id}>
              <SettingsRow
                title={
                  <span className="flex items-center gap-2">
                    <AppWindowIcon className="size-4 text-muted-foreground" />
                    {profile.name || "Mac app"}
                  </span>
                }
                id={`external-app-${profile.id}`}
                description={
                  profile.id === "excel"
                    ? "Let your agent test Excel in its real window, with an optional add-in Inspector."
                    : "View a native Mac window and its optional debugger."
                }
                control={
                  <Switch
                    aria-label={`Enable ${profile.name || "Mac app"}`}
                    checked={profile.enabled}
                    onCheckedChange={(enabled) => save(profile.id, { enabled })}
                  />
                }
              />
              {profile.enabled ? (
                <>
                  {profile.id !== "excel" ? (
                    <SettingsRow
                      title="App name"
                      description="Shown in the session panel."
                      control={
                        <Input
                          aria-label={`Name for ${profile.name || "Mac app"}`}
                          value={profile.name}
                          maxLength={120}
                          onChange={(event) => save(profile.id, { name: event.target.value })}
                        />
                      }
                    />
                  ) : null}
                  <SettingsRow
                    title="Application filter"
                    description="Match an app name or bundle ID. Leave empty to choose from all Mac windows."
                    control={
                      <Input
                        aria-label={`Application filter for ${profile.name || "Mac app"}`}
                        value={profile.applicationFilter}
                        maxLength={120}
                        placeholder="e.g. com.microsoft.Excel"
                        onChange={(event) =>
                          save(profile.id, { applicationFilter: event.target.value })
                        }
                      />
                    }
                  />
                  <SettingsRow
                    title="Web Inspector"
                    description="Choose an undocked Inspector alongside the app."
                    control={
                      <Switch
                        aria-label={`Inspector for ${profile.name || "Mac app"}`}
                        checked={profile.includeInspector}
                        onCheckedChange={(includeInspector) =>
                          save(profile.id, { includeInspector })
                        }
                      />
                    }
                  />
                  {profile.includeInspector ? (
                    <SettingsRow
                      title="Inspector filter"
                      description="Match the debugger’s window title."
                      control={
                        <Input
                          aria-label={`Inspector filter for ${profile.name || "Mac app"}`}
                          value={profile.inspectorFilter}
                          maxLength={120}
                          onChange={(event) =>
                            save(profile.id, { inspectorFilter: event.target.value })
                          }
                        />
                      }
                    />
                  ) : null}
                  {profile.id === "excel" ? (
                    <div className="space-y-3 px-3 py-4 sm:px-4">
                      <p className="text-sm">
                        Optional: enable Web Inspector for Excel add-in debugging.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Save your workbook and quit Excel before running this command. Reopen the
                        add-in, right-click its task pane, choose Inspect Element, and undock the
                        Inspector.
                      </p>
                      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
                        <code className="min-w-0 flex-1 break-all text-xs">{excelSetup}</code>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Copy Excel setup command"
                          onClick={() => {
                            void navigator.clipboard.writeText(excelSetup).then(
                              () => setMessage("Excel setup command copied."),
                              () => setMessage("Select the command to copy it."),
                            );
                          }}
                        >
                          <CopyIcon />
                        </Button>
                      </div>
                      <a
                        className="text-xs text-primary underline underline-offset-4"
                        href="https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-office-add-ins-on-ipad-and-mac"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Microsoft’s Mac setup guide
                      </a>
                    </div>
                  ) : null}
                </>
              ) : null}
              {profile.id !== "excel" ? (
                <div className="flex justify-end px-3 py-2 sm:px-4">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void disconnect((binding) => binding.profileId === profile.id);
                      useRightPanelStore.getState().removeExternalAppProfile(profile.id);
                      update({
                        externalAppProfiles: profiles.filter((entry) => entry.id !== profile.id),
                      });
                    }}
                  >
                    <Trash2Icon /> Remove app
                  </Button>
                </div>
              ) : null}
            </SettingsGroup>
          ))}
        </div>
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        macOS 14 or later. Viewing needs Screen Recording on the app’s Mac; optional controls need
        Accessibility. Enabling an app here does not grant macOS permissions or launch it.
      </p>
      {message ? (
        <p role="status" className="px-3 text-xs text-muted-foreground sm:px-4">
          {message}
        </p>
      ) : null}
    </div>
  );
}
