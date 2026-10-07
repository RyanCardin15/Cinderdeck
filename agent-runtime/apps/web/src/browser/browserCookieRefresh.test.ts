import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type BrowserCookieSource,
  type BrowserImportResult,
} from "@cinderdeck/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importBrowserCookies: vi.fn(),
  setClientSettings: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock("~/components/preview/previewBridge", () => ({ previewBridge: mocks }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.addToast } }));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence: mocks }) }));

import {
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsUpdate,
} from "~/hooks/useSettings";
import {
  disconnectBrowserCookieSource,
  refreshBrowserCookies,
  refreshBrowserCookiesWithFeedback,
  replaceBrowserCookieSource,
  withBrowserCookieRefreshPaused,
} from "./browserCookieRefresh";

const environmentId = EnvironmentId.make("local");
const source: BrowserCookieSource = {
  environmentId,
  targetProfileId: "work",
  sourceId: "chrome",
  sourceName: "Chrome",
  sourceProfileDirectory: "Profile 2",
  sourceProfileName: "Work account",
};
const result = { imported: 2, skipped: 0, skippedDomains: [] };
const settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" as const }],
  browserCookieSources: [source],
};

beforeEach(() => {
  __setClientSettingsForTests(settings);
  mocks.importBrowserCookies.mockReset().mockResolvedValue(result);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.addToast.mockReset();
});

describe("browser cookie refresh", () => {
  it("uses the saved source and scopes refresh to its environment and destination", async () => {
    await expect(refreshBrowserCookies(EnvironmentId.make("other"), "work")).resolves.toBeNull();
    await expect(refreshBrowserCookies(environmentId, "personal")).resolves.toBeNull();
    expect(mocks.importBrowserCookies).not.toHaveBeenCalled();
    await expect(refreshBrowserCookies(environmentId, "work")).resolves.toEqual(result);
    expect(mocks.importBrowserCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      sourceId: "chrome",
      sourceProfileDirectory: "Profile 2",
      targetProfileId: "work",
    });
  });

  it("shares a pending refresh across tabs and reads again on a later opening", async () => {
    let finish!: (value: BrowserImportResult) => void;
    mocks.importBrowserCookies.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = refreshBrowserCookies(environmentId, "work");
    const second = refreshBrowserCookies(environmentId, "work");
    expect(second).toBe(first);
    await Promise.resolve();
    expect(mocks.importBrowserCookies).toHaveBeenCalledOnce();
    finish(result);
    await Promise.all([first, second]);
    await refreshBrowserCookies(environmentId, "work");
    expect(mocks.importBrowserCookies).toHaveBeenCalledTimes(2);
  });

  it("reports a failed refresh, keeps the source, and allows retry", async () => {
    mocks.importBrowserCookies.mockRejectedValueOnce(
      new Error("Importing cookies from chrome failed: needsKeychainApproval."),
    );
    await expect(refreshBrowserCookiesWithFeedback(environmentId, "work")).resolves.toBeNull();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining("Existing cookies were kept"),
      }),
    );
    expect(getClientSettings().browserCookieSources).toEqual([source]);
    await expect(refreshBrowserCookiesWithFeedback(environmentId, "work")).resolves.toEqual(result);
  });

  it("reports skipped cookies and manual refresh completion", async () => {
    mocks.importBrowserCookies.mockResolvedValueOnce({
      imported: 1,
      skipped: 3,
      skippedDomains: ["example.com"],
    });
    await refreshBrowserCookiesWithFeedback(environmentId, "work");
    expect(mocks.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringContaining("3 skipped") }),
    );
    await refreshBrowserCookiesWithFeedback(environmentId, "work", true);
    expect(mocks.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Browser cookies refreshed" }),
    );
  });

  it("waits for refresh before clearing and disconnects durably before another opening", async () => {
    let finish!: (value: BrowserImportResult) => void;
    mocks.importBrowserCookies.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshBrowserCookies(environmentId, "work");
    await Promise.resolve();
    const clear = vi.fn();
    const clearing = withBrowserCookieRefreshPaused([environmentId], "work", async () => {
      await disconnectBrowserCookieSource("work", environmentId);
      clear();
    });
    expect(clear).not.toHaveBeenCalled();
    const openingDuringClear = refreshBrowserCookies(environmentId, "work");
    finish(result);
    await Promise.all([refresh, clearing]);
    await expect(openingDuringClear).resolves.toBeNull();
    expect(clear).toHaveBeenCalledOnce();
    expect(mocks.setClientSettings).toHaveBeenCalledWith(
      expect.objectContaining({ browserCookieSources: [] }),
    );
    await expect(refreshBrowserCookies(environmentId, "work")).resolves.toBeNull();
    expect(mocks.importBrowserCookies).toHaveBeenCalledOnce();
  });

  it("retains the connection when saving a disconnect fails", async () => {
    mocks.setClientSettings.mockRejectedValueOnce(new Error("disk full"));
    await expect(disconnectBrowserCookieSource("work", environmentId)).rejects.toThrow("disk full");
    expect(getClientSettings().browserCookieSources).toEqual([source]);
  });

  it("serializes imports, clears, and disconnects on an overlapping partition", async () => {
    let finish!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const events: string[] = [];
    const first = withBrowserCookieRefreshPaused([environmentId], "work", async () => {
      events.push("import");
      signalStarted();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      events.push("saved");
    });
    const second = withBrowserCookieRefreshPaused([environmentId, "other"], "work", async () => {
      events.push("clear");
    });
    await started;
    expect(events).toEqual(["import"]);
    finish();
    await Promise.all([first, second]);
    expect(events).toEqual(["import", "saved", "clear"]);
    await expect(refreshBrowserCookies(environmentId, "work")).resolves.toEqual(result);
  });

  it("persists a new source without losing other environments, profiles, or settings", async () => {
    const other = { ...source, environmentId: "other" };
    const personal = { ...source, targetProfileId: "personal" };
    const replacement = { ...source, sourceProfileDirectory: "Profile 3" };
    __setClientSettingsForTests({ ...settings, browserCookieSources: [source, other, personal] });
    await persistClientSettingsUpdate((current) => ({
      ...current,
      browserCookieSources: replaceBrowserCookieSource(current.browserCookieSources, replacement),
    }));
    expect(getClientSettings().browserCookieSources).toEqual([other, personal, replacement]);
    expect(getClientSettings().browserProfiles).toEqual(settings.browserProfiles);
    await disconnectBrowserCookieSource("work", environmentId);
    expect(getClientSettings().browserCookieSources).toEqual([other, personal]);
  });
});
