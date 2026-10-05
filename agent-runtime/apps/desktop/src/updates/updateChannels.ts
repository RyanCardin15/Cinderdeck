import type { DesktopUpdateChannel } from "@cinderdeck/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
const PREVIEW_VERSION_PATTERN = /^[^-+]+-(?:preview\.\d{8}\.\d+|pr\.\d+(?:\.[A-Za-z0-9-]+)*)$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

// Preview installs are distributed by hand without an updater feed.
export function isPreviewDesktopVersion(version: string): boolean {
  return PREVIEW_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
