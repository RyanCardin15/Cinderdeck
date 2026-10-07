import {
  BROWSER_IMPORT_FAILURE_COPY,
  BrowserImportFailureReason,
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserCookieSource,
  type BrowserImportResult,
  type DesktopPreviewBridge,
  type EnvironmentId,
} from "@cinderdeck/contracts";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";
import {
  getClientSettings,
  ensureClientSettingsHydrated,
  persistClientSettingsUpdate,
} from "~/hooks/useSettings";

export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

const keyFor = (environmentId: string, profileId: string) =>
  JSON.stringify([environmentId, profileId]);

const tasks = new Map<string, Promise<BrowserImportResult | null>>();
const paused = new Map<string, number>();
const mutations = new Map<string, Promise<void>>();
const feedbackTasks = new Map<string, Promise<BrowserImportResult | null>>();

export function findBrowserCookieSource(environmentId: string, profileId?: string) {
  return getClientSettings().browserCookieSources.find(
    (source) =>
      source.environmentId === environmentId &&
      source.targetProfileId === (profileId ?? DEFAULT_BROWSER_PROFILE_ID),
  );
}

export function replaceBrowserCookieSource(
  sources: ReadonlyArray<BrowserCookieSource>,
  source: BrowserCookieSource,
): ReadonlyArray<BrowserCookieSource> {
  return [
    ...sources.filter(
      (entry) =>
        entry.environmentId !== source.environmentId ||
        entry.targetProfileId !== source.targetProfileId,
    ),
    source,
  ];
}

/** Share a read/write across tabs using the same local partition. */
export function refreshBrowserCookies(
  environmentId: EnvironmentId,
  profileId = DEFAULT_BROWSER_PROFILE_ID,
  bridge: Pick<DesktopPreviewBridge, "importBrowserCookies"> | null = previewBridge,
): Promise<BrowserImportResult | null> {
  const key = keyFor(environmentId, profileId);
  if (paused.has(key)) {
    // Wait for an explicit import/clear, then resolve the source again. A clear
    // disconnects it before this retry, so it cannot silently restore logins.
    return (mutations.get(key) ?? Promise.resolve()).then(() =>
      refreshBrowserCookies(environmentId, profileId, bridge),
    );
  }
  const current = tasks.get(key);
  if (current) return current;
  const source = findBrowserCookieSource(environmentId, profileId);
  if (!source || !bridge) return Promise.resolve(null);
  const task = Promise.resolve().then(() =>
    bridge.importBrowserCookies({
      environmentId,
      targetProfileId: profileId,
      sourceId: source.sourceId,
      sourceProfileDirectory: source.sourceProfileDirectory,
    }),
  );
  tasks.set(key, task);
  void task
    .finally(() => {
      if (tasks.get(key) === task) tasks.delete(key);
    })
    .catch(() => undefined);
  return task;
}

/** Existing cookies remain intact on failure; the caller can still open the tab. */
export function refreshBrowserCookiesWithFeedback(
  environmentId: EnvironmentId,
  profileId = DEFAULT_BROWSER_PROFILE_ID,
  manual = false,
): Promise<BrowserImportResult | null> {
  const source = findBrowserCookieSource(environmentId, profileId);
  if (!source) return Promise.resolve(null);
  const key = JSON.stringify([environmentId, profileId, manual]);
  const current = feedbackTasks.get(key);
  if (current) return current;
  const task = (async () => {
    try {
      const result = await refreshBrowserCookies(environmentId, profileId);
      if (result && (manual || result.skipped > 0)) {
        toastManager.add({
          type: result.imported > 0 ? "success" : "info",
          title: result.imported > 0 ? "Browser cookies refreshed" : "No cookies refreshed",
          description: `${result.imported} imported from ${source.sourceName} · ${source.sourceProfileName}.${result.skipped > 0 ? ` ${result.skipped} skipped; some sites may need sign-in.` : ""}`,
        });
      }
      return result;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not refresh cookies from ${source.sourceName}`,
        description: `${BROWSER_IMPORT_FAILURE_COPY[importFailureReason(cause)]} Existing cookies were kept.`,
      });
      return null;
    }
  })();
  feedbackTasks.set(key, task);
  void task
    .finally(() => {
      if (feedbackTasks.get(key) === task) feedbackTasks.delete(key);
    })
    .catch(() => undefined);
  return task;
}

/** Imports and destructive actions wait for pending refreshes and exclude new ones. */
export async function withBrowserCookieRefreshPaused<A>(
  environmentIds: ReadonlyArray<string>,
  profileId: string,
  action: () => Promise<A>,
): Promise<A> {
  const keys = [
    ...new Set(environmentIds.map((environmentId) => keyFor(environmentId, profileId))),
  ];
  const predecessors = keys.map((key) => mutations.get(key));
  let release!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const key of keys) mutations.set(key, completion);
  for (const key of keys) paused.set(key, (paused.get(key) ?? 0) + 1);
  try {
    await Promise.all(predecessors);
    await Promise.all(keys.map((key) => tasks.get(key)?.catch(() => undefined)));
    return await action();
  } finally {
    for (const key of keys) {
      const count = (paused.get(key) ?? 1) - 1;
      if (count === 0) paused.delete(key);
      else paused.set(key, count);
      if (mutations.get(key) === completion) mutations.delete(key);
    }
    release();
  }
}

export async function disconnectBrowserCookieSource(profileId: string, environmentId?: string) {
  await ensureClientSettingsHydrated();
  if (
    !getClientSettings().browserCookieSources.some(
      (source) =>
        source.targetProfileId === profileId &&
        (environmentId === undefined || source.environmentId === environmentId),
    )
  )
    return;
  await persistClientSettingsUpdate((settings) => ({
    ...settings,
    browserCookieSources: settings.browserCookieSources.filter(
      (source) =>
        source.targetProfileId !== profileId ||
        (environmentId !== undefined && source.environmentId !== environmentId),
    ),
  }));
}
