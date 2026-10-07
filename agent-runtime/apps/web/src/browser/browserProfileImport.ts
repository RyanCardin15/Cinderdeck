import {
  BROWSER_PROFILE_MAX_COUNT,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type DesktopPreviewBridge,
  type EnvironmentId,
} from "@cinderdeck/contracts";
import { getClientSettings, persistClientSettingsUpdate } from "~/hooks/useSettings";
import type { ImportOutcome, WizardTarget } from "~/components/settings/browserImportWizard.logic";
import {
  importFailureReason,
  replaceBrowserCookieSource,
  withBrowserCookieRefreshPaused,
} from "./browserCookieRefresh";

class ProfileLimitReachedError extends Error {}

/** Saves the source with the profile only after cookies actually arrive. */
export function importBrowserProfileCookies(
  bridge: Pick<DesktopPreviewBridge, "importBrowserCookies" | "clearCookies" | "clearCache">,
  source: BrowserImportSource,
  environmentId: EnvironmentId,
  input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
): Promise<ImportOutcome> {
  return withBrowserCookieRefreshPaused([environmentId], input.target.profileId, async () => {
    const targetExists = () =>
      resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      );
    if (input.target.kind === "existing" && !targetExists()) {
      return { kind: "blocked", reason: "readFailed" };
    }
    try {
      const result = await bridge.importBrowserCookies({
        environmentId,
        sourceId: source.id,
        sourceProfileDirectory: input.sourceProfileDirectory,
        targetProfileId: input.target.profileId,
      });
      if (input.target.kind === "existing" && !targetExists()) {
        return { kind: "blocked", reason: "readFailed" };
      }
      const sourceLink = {
        environmentId,
        targetProfileId: input.target.profileId,
        sourceId: source.id,
        sourceName: source.name,
        sourceProfileDirectory: input.sourceProfileDirectory,
        sourceProfileName:
          source.profiles.find((profile) => profile.directory === input.sourceProfileDirectory)
            ?.name ?? input.sourceProfileDirectory,
      };
      let targetName = input.target.kind === "existing" ? input.target.name : source.name;
      if (result.imported > 0) {
        try {
          // One durable write registers both the new profile and its source,
          // using the latest settings so concurrent unrelated edits survive.
          const persisted = await persistClientSettingsUpdate((current) => {
            let profiles = current.browserProfiles;
            if (
              input.target.kind === "new" &&
              !profiles.some((profile) => profile.id === input.target.profileId)
            ) {
              if (profiles.length >= BROWSER_PROFILE_MAX_COUNT)
                throw new ProfileLimitReachedError();
              const taken = new Set(
                resolveBrowserProfiles(profiles).map((profile) => profile.name),
              );
              let name = source.name;
              for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
              profiles = [
                ...profiles,
                { id: input.target.profileId, name, kind: "persistent" as const },
              ];
            }
            return {
              ...current,
              browserProfiles: profiles,
              browserCookieSources: replaceBrowserCookieSource(
                current.browserCookieSources,
                sourceLink,
              ),
            };
          });
          targetName =
            resolveBrowserProfiles(persisted.browserProfiles).find(
              (profile) => profile.id === input.target.profileId,
            )?.name ?? targetName;
        } catch (cause) {
          if (input.target.kind === "new") {
            // Already holding this partition's mutation lock: clean up directly,
            // without queuing a nested clear behind our own unfinished import.
            await Promise.all([
              bridge.clearCookies(environmentId, input.target.profileId),
              bridge.clearCache(environmentId, input.target.profileId),
            ]).catch(() => undefined);
          }
          const reason =
            cause instanceof ProfileLimitReachedError
              ? "profileLimitReached"
              : input.target.kind === "new"
                ? "profileNotSaved"
                : "sourceNotSaved";
          throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
        }
      }
      return { kind: "imported", ...result, targetName };
    } catch (cause) {
      return { kind: "blocked", reason: importFailureReason(cause) };
    }
  });
}
