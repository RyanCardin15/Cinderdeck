import { describe, expect, it } from "vite-plus/test";

import {
  isNightlyDesktopVersion,
  isPreviewDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("separates preview identity from nightly while retaining the no-feed channel default", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(false);
    expect(isPreviewDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(isPreviewDesktopVersion("0.0.41-pr.123.7")).toBe(true);
    expect(isPreviewDesktopVersion("0.0.41-nightly.20260911.7")).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
    expect(isPreviewDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
  });
});
