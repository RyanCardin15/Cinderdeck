import {
  BROWSER_PROFILE_MAX_COUNT,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type BrowserCookieSource,
  type BrowserImportSource,
} from "@cinderdeck/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistence = vi.hoisted(() => ({ setClientSettings: vi.fn() }));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { importBrowserProfileCookies } from "./browserProfileImport";

const environmentId = EnvironmentId.make("local");
const source: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Profile 2", name: "Work account" }],
};
const result = { imported: 2, skipped: 1, skippedDomains: ["example.com"] };
const bridge = {
  importBrowserCookies: vi.fn(),
  clearCookies: vi.fn(),
  clearCache: vi.fn(),
};
const input = {
  sourceProfileDirectory: "Profile 2",
  target: { kind: "new" as const, profileId: "work" },
};
const link: BrowserCookieSource = {
  environmentId,
  targetProfileId: "work",
  sourceId: "chrome",
  sourceName: "Chrome",
  sourceProfileDirectory: "Profile 2",
  sourceProfileName: "Work account",
};

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  bridge.importBrowserCookies.mockReset().mockResolvedValue(result);
  bridge.clearCookies.mockReset().mockResolvedValue(undefined);
  bridge.clearCache.mockReset().mockResolvedValue(undefined);
});

describe("importBrowserProfileCookies", () => {
  it("saves a new profile and its exact source in the same durable write", async () => {
    await expect(
      importBrowserProfileCookies(bridge, source, environmentId, input),
    ).resolves.toEqual({
      kind: "imported",
      ...result,
      targetName: "Chrome",
    });
    expect(persistence.setClientSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        browserProfiles: [{ id: "work", name: "Chrome", kind: "persistent" }],
        browserCookieSources: [link],
      }),
    );
    expect(getClientSettings().browserCookieSources).toEqual([link]);
  });

  it("connects an existing profile and preserves other source links", async () => {
    const old = { ...link, environmentId: "other", sourceId: "firefox" as const };
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserCookieSources: [old] });
    await importBrowserProfileCookies(bridge, source, environmentId, {
      ...input,
      target: { kind: "existing", profileId: "default", name: "Default" },
    });
    expect(getClientSettings().browserProfiles).toEqual([]);
    expect(getClientSettings().browserCookieSources).toEqual([
      old,
      { ...link, targetProfileId: "default" },
    ]);
  });

  it("does not create a profile or link when no cookies arrive", async () => {
    bridge.importBrowserCookies.mockResolvedValueOnce({
      imported: 0,
      skipped: 3,
      skippedDomains: [],
    });
    await importBrowserProfileCookies(bridge, source, environmentId, input);
    expect(getClientSettings().browserProfiles).toEqual([]);
    expect(getClientSettings().browserCookieSources).toEqual([]);
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
  });

  it("cleans up an orphan partition when saving the new profile fails without deadlocking", async () => {
    persistence.setClientSettings.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      importBrowserProfileCookies(bridge, source, environmentId, input),
    ).resolves.toEqual({ kind: "blocked", reason: "profileNotSaved" });
    expect(bridge.clearCookies).toHaveBeenCalledExactlyOnceWith(environmentId, "work");
    expect(bridge.clearCache).toHaveBeenCalledExactlyOnceWith(environmentId, "work");
    expect(getClientSettings().browserCookieSources).toEqual([]);
  });

  it("preserves existing cookies when their source link cannot be saved", async () => {
    persistence.setClientSettings.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      importBrowserProfileCookies(bridge, source, environmentId, {
        ...input,
        target: { kind: "existing", profileId: "default", name: "Default" },
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "sourceNotSaved" });
    expect(bridge.clearCookies).not.toHaveBeenCalled();
    expect(getClientSettings().browserCookieSources).toEqual([]);
  });

  it("enforces the profile limit against the latest saved settings", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: Array.from({ length: BROWSER_PROFILE_MAX_COUNT }, (_, index) => ({
        id: `profile-${index}`,
        name: `Profile ${index}`,
        kind: "persistent" as const,
      })),
    });
    await expect(
      importBrowserProfileCookies(bridge, source, environmentId, input),
    ).resolves.toEqual({ kind: "blocked", reason: "profileLimitReached" });
    expect(bridge.clearCookies).toHaveBeenCalledOnce();
    expect(getClientSettings().browserCookieSources).toEqual([]);
  });

  it("leaves existing links intact when the source read fails", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserCookieSources: [link] });
    bridge.importBrowserCookies.mockRejectedValueOnce(
      new Error("Importing cookies from chrome failed: needsKeychainApproval."),
    );
    await expect(
      importBrowserProfileCookies(bridge, source, environmentId, input),
    ).resolves.toEqual({ kind: "blocked", reason: "needsKeychainApproval" });
    expect(getClientSettings().browserCookieSources).toEqual([link]);
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
  });
});
