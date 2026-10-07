import { describe, expect, it } from "vite-plus/test";
import { hasDesktopRendererAccess } from "./desktopRendererAccess.ts";

describe("private desktop renderer access", () => {
  const token = "private-desktop-renderer-token-at-least-32-characters";
  it.each([undefined, "", "wrong", [token]])(
    "rejects missing, wrong, or duplicate credentials: %j",
    (supplied) => {
      expect(hasDesktopRendererAccess(token, supplied)).toBe(false);
    },
  );
  it.each([undefined, "", "short"])(
    "fails closed with an unconfigured or weak launcher token: %j",
    (expected) => {
      expect(hasDesktopRendererAccess(expected, expected)).toBe(false);
    },
  );
  it("accepts the private main-process credential", () => {
    expect(hasDesktopRendererAccess(token, token)).toBe(true);
  });
});
