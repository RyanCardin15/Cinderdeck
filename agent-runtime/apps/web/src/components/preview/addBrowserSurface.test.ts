import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@cinderdeck/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";

import { addBrowserSurface } from "./addBrowserSurface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
});

describe("addBrowserSurface", () => {
  it("opens under the requested profile", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    await addBrowserSurface({
      threadRef,
      openPreview: ({ input }) => openPreview(input),
      profileId: "profile-work",
    });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-work",
    });
  });

  it("creates another preview session when a browser tab is already active", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-1", "browser:tab-2"]);
  });
});

const panelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

it("opens the first browser panel before backend setup resolves", async () => {
  let finish!: (result: ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>) => void;
  const request = addBrowserSurface({
    threadRef,
    openPreview: () =>
      new Promise<ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>>((resolve) => {
        finish = resolve;
      }),
  });
  expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:new" });
  useRightPanelStore.getState().reconcileBrowserSurfaces(threadRef, []);
  expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:new" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(AsyncResult.success(snapshot("tab-1")));
  await request;
  expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:tab-1" });
  expect(panelState().surfaces).toHaveLength(1);
});

it("does not reopen the panel if it was closed during first-browser setup", async () => {
  let finish!: (result: ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>) => void;
  const request = addBrowserSurface({
    threadRef,
    openPreview: () =>
      new Promise<ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>>((resolve) => {
        finish = resolve;
      }),
  });
  useRightPanelStore.getState().close(threadRef);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(AsyncResult.success(snapshot("tab-1")));
  await request;
  expect(panelState().isOpen).toBe(false);
  expect(panelState().surfaces.some((surface) => surface.id === "browser:new")).toBe(false);
});

it("clears the pending first-browser panel after a backend failure", async () => {
  const result = await addBrowserSurface({
    threadRef,
    openPreview: async () => AsyncResult.failure(Cause.fail(new Error("Preview unavailable"))),
  });
  expect(result._tag).toBe("Failure");
  expect(panelState()).toMatchObject({ isOpen: false, activeSurfaceId: null, surfaces: [] });
});
