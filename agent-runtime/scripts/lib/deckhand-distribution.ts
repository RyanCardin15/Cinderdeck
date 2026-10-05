/** Cinderdeck builds must not inherit the former product’s cloud accounts or telemetry. */
export function withoutUpstreamServices(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      /^(?:T3CODE|DECKHAND|VITE|EXPO_PUBLIC)_(?:CLERK|RELAY|T3CODE_RELAY|DECKHAND_RELAY|POSTHOG|TELEMETRY|MOBILE_OTLP|OTLP)/.test(
        key,
      )
        ? ""
        : value,
    ]),
  );
}
