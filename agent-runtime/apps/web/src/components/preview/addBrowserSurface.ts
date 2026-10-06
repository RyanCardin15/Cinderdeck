import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@cinderdeck/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@cinderdeck/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";
import { readThreadPreviewState } from "~/previewStateStore";

import { openPreviewSession } from "./openPreviewSession";

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const panels = useRightPanelStore.getState();
  panels.openBrowser(input.threadRef, null);
  const revision = panels.getUserActionRevision(input.threadRef);
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
  if (result._tag === "Failure") {
    // A failed setup must not leave a nonfunctional pending tab behind.
    panels.closeSurface(input.threadRef, "browser:new");
  }
  return mapAtomCommandResult(result, (snapshot) => {
    const current = useRightPanelStore.getState();
    if (current.getUserActionRevision(input.threadRef) === revision) {
      current.openBrowser(input.threadRef, snapshot.tabId);
    } else {
      // A user who closed or switched panels during setup keeps that choice.
      current.closeSurface(input.threadRef, "browser:new");
      current.reconcileBrowserSurfaces(
        input.threadRef,
        Object.keys(readThreadPreviewState(input.threadRef).sessions),
      );
    }
  });
}
