import {
  managedCapabilityDenial,
  type BrowserImportSource,
  type DesktopPreviewBridge,
  type EnvironmentId,
} from "@cinderdeck/contracts";
import { useState } from "react";
import {
  findBrowserCookieSource,
  refreshBrowserCookiesWithFeedback,
} from "~/browser/browserCookieRefresh";
import { importBrowserProfileCookies } from "~/browser/browserProfileImport";
import { BrowserImportWizard } from "~/components/settings/BrowserImportWizard";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { ensureClientSettingsHydrated } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";

export interface PreviewCookieRefreshTarget {
  readonly bridge: Pick<
    DesktopPreviewBridge,
    "listBrowserImportSources" | "importBrowserCookies" | "clearCookies" | "clearCache"
  >;
  readonly environmentId: EnvironmentId;
  readonly environmentName: string;
  readonly profile: { readonly id: string; readonly name: string };
  readonly reload: () => Promise<void>;
}

export function usePreviewCookieRefresh(target: PreviewCookieRefreshTarget | undefined) {
  const [pending, setPending] = useState(false);
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource>>([]);
  const denial = managedCapabilityDenial(usePrimaryManagedPolicy(), "browserCookieImport");
  const reload = async () => {
    try {
      await target?.reload();
    } catch {
      toastManager.add({
        type: "error",
        title: "Cookies refreshed, but the page could not reload",
      });
    }
  };

  const refresh = async () => {
    if (!target || pending) return;
    if (denial) {
      toastManager.add({ type: "error", title: denial });
      return;
    }
    setPending(true);
    try {
      await ensureClientSettingsHydrated();
      if (findBrowserCookieSource(target.environmentId, target.profile.id)) {
        if (
          await refreshBrowserCookiesWithFeedback(target.environmentId, target.profile.id, true)
        ) {
          await reload();
        }
      } else {
        const installed = (await target.bridge.listBrowserImportSources()).filter(
          (source) =>
            source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
        );
        if (installed.length) setSources(installed);
        else
          toastManager.add({ type: "info", title: "No supported browsers found on this computer" });
      }
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not load browser profiles. Try Refresh cookies again.",
      });
    }
    setPending(false);
  };

  const close = () => setSources([]);
  const source = sources.length === 1 ? sources[0] : undefined;
  const dialog =
    !target || sources.length === 0 ? null : source ? (
      <BrowserImportWizard
        source={source}
        destinationEnvironmentName={target.environmentName}
        targetProfiles={[target.profile]}
        canCreateProfile={false}
        onImport={async (input) => {
          const outcome = await importBrowserProfileCookies(
            target.bridge,
            source,
            target.environmentId,
            input,
          );
          if (outcome.kind === "imported" && outcome.imported > 0) await reload();
          return outcome;
        }}
        onRefreshSource={async () =>
          (await target.bridge.listBrowserImportSources()).find(
            (updated) => updated.id === source.id,
          )
        }
        onOpenFullDiskAccessSettings={() =>
          ensureLocalApi().shell.openSystemSettings("full-disk-access")
        }
        onCheckFullDiskAccess={
          window.desktopBridge
            ? () => window.desktopBridge!.checkSystemPermission("full-disk-access")
            : undefined
        }
        onClose={close}
      />
    ) : (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogTitle>Choose a cookie source</DialogTitle>
          <DialogDescription>
            Which browser should refresh cookies for {target.profile.name}?
          </DialogDescription>
          <DialogPanel>
            <div className="grid gap-2">
              {sources.map((browser) => (
                <Button key={browser.id} variant="outline" onClick={() => setSources([browser])}>
                  {browser.name}
                </Button>
              ))}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  return { refresh, pending, dialog };
}
