import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["cinderdeck-companion://", "cinderdeck-companion:///", "cinderdeck-companion-dev://", "cinderdeck-companion-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );

  it.each([
    "cinderdeck-companion://threads/env-1/thread-1",
    "cinderdeck-companion://pair?pairingUrl=x",
    "cinderdeck-companion-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each(["cinderdeck-companion://expo-development-client/?url=x", "cinderdeck-companion://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
