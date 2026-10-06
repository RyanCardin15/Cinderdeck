/** Resolve a disclosure-row click without stealing a nested control's action. */
export function diffHeaderFilePath(path: readonly EventTarget[]): string | null {
  if (
    path.some(
      (node) =>
        node instanceof Element &&
        node.matches("button, a, input, select, textarea, [role=button]"),
    )
  )
    return null;
  const header = path.find(
    (node): node is Element => node instanceof Element && node.hasAttribute("data-diffs-header"),
  );
  return header?.querySelector("[data-title]")?.textContent?.trim() || null;
}
