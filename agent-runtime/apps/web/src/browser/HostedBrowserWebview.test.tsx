import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@cinderdeck/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  importBrowserCookies: vi.fn<DesktopPreviewBridge["importBrowserCookies"]>(),
  refresh: vi.fn<DesktopPreviewBridge["refresh"]>(),
  addToast: vi.fn(),
  activeRecordings: new Set<string>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    importBrowserCookies: mocks.importBrowserCookies,
    refresh: mocks.refresh,
  },
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.addToast } }));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  mocks.importBrowserCookies
    .mockReset()
    .mockResolvedValue({ imported: 1, skipped: 0, skippedDomains: [] });
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.addToast.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview settings hydration", () => {
  it("refreshes before the first request and refreshes a retained tab when reopened", async () => {
    const refresh = deferred<Awaited<ReturnType<DesktopPreviewBridge["importBrowserCookies"]>>>();
    const threadRef = {
      environmentId: EnvironmentId.make("cookie-source"),
      threadId: ThreadId.make("cookie-thread"),
    };
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      browserCookieSources: [
        {
          environmentId: threadRef.environmentId,
          targetProfileId: "work",
          sourceId: "chrome",
          sourceName: "Chrome",
          sourceProfileDirectory: "Profile 2",
          sourceProfileName: "Work account",
        },
      ],
    });
    mocks.importBrowserCookies.mockReturnValueOnce(refresh.promise);
    const runtimeTabId = "cookie-tab";
    const owner = Symbol("panel");
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const store = useBrowserSurfaceStore.getState();
    store.claim(runtimeTabId, owner, false);
    store.present(runtimeTabId, owner, rect, true, 0, 30);
    const guest = vi.fn(() => Object.assign(new EventTarget(), { getWebContentsId: () => 42 }));
    await act(async () => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-cookie-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview" ? guest() : { scrollTo: () => undefined },
        },
      );
      await ensureClientSettingsHydrated();
    });
    expect(mocks.importBrowserCookies).toHaveBeenCalledOnce();
    expect(guest).not.toHaveBeenCalled();
    await act(async () => {
      refresh.resolve({ imported: 1, skipped: 0, skippedDomains: [] });
      await refresh.promise;
    });
    expect(guest).toHaveBeenCalledOnce();
    expect(mocks.importBrowserCookies).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(() => store.present(runtimeTabId, owner, rect, false, 0, 30));
    await act(async () => store.present(runtimeTabId, owner, rect, true, 0, 30));
    expect(mocks.importBrowserCookies).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    // Size changes while visible are not another panel opening.
    await act(() => store.present(runtimeTabId, owner, { ...rect, width: 900 }, true, 0, 30));
    expect(mocks.importBrowserCookies).toHaveBeenCalledTimes(2);
    // A failed later refresh keeps the existing guest and reports the reason.
    mocks.importBrowserCookies.mockRejectedValueOnce(
      new Error("Importing cookies from chrome failed: needsKeychainApproval."),
    );
    await act(() => store.present(runtimeTabId, owner, rect, false, 0, 30));
    await act(async () => store.present(runtimeTabId, owner, rect, true, 0, 30));
    expect(guest).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("loads the existing cookies when the initial refresh fails", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("cookie-error"),
      threadId: ThreadId.make("cookie-thread"),
    };
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      browserCookieSources: [
        {
          environmentId: threadRef.environmentId,
          targetProfileId: "default",
          sourceId: "chrome",
          sourceName: "Chrome",
          sourceProfileDirectory: "Default",
          sourceProfileName: "Personal",
        },
      ],
    });
    mocks.importBrowserCookies.mockRejectedValueOnce(
      new Error("Importing cookies from chrome failed: readFailed."),
    );
    await act(async () => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="error-tab"
          runtimeTabId="runtime-error-tab"
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId={undefined}
          zoomFactor={1}
        />,
      );
      await ensureClientSettingsHydrated();
    });
    expect(renderer!.root.findByType("webview").props.src).toBe("https://example.com");
    expect(mocks.importBrowserCookies).toHaveBeenCalledOnce();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Existing cookies were kept"),
      }),
    );
  });

  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const createGuest = vi.fn((_attributes: unknown) =>
      Object.assign(new EventTarget(), { getWebContentsId: () => 41 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? createGuest(element.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(threadRef.environmentId, "work");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: "persist:t3-preview-work",
        src: "https://example.com",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});
