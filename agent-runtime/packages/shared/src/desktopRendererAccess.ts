/** Private main-process credential for the desktop development renderer. */
export const DESKTOP_RENDERER_ACCESS_HEADER = "x-cinderdeck-desktop-renderer";

export function hasDesktopRendererAccess(
  expectedToken: string | undefined,
  suppliedToken: string | string[] | undefined,
): boolean {
  return (
    expectedToken !== undefined &&
    expectedToken.length >= 32 &&
    typeof suppliedToken === "string" &&
    suppliedToken === expectedToken
  );
}
