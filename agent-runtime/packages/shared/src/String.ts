export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

/**
 * Lowercases ASCII letters only, so every index in the result maps to the
 * same index in the input (unlike `toLowerCase`, which can change length).
 */
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
