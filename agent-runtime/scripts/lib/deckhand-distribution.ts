/** A fork must never acquire a vendor account or telemetry destination from a build machine. */
export function withoutUpstreamServices(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      /^(?:T3CODE|DECKHAND|VITE|EXPO_PUBLIC)_(?:CLERK|RELAY|T3CODE_RELAY|DECKHAND_RELAY|POSTHOG|TELEMETRY|MOBILE_OTLP)/.test(
        key,
      )
        ? ""
        : value,
    ]),
  );
}
