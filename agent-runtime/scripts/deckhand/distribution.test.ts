import { describe, expect, it } from "vite-plus/test";
import { withoutUpstreamServices } from "../lib/deckhand-distribution.ts";

describe("Deckhand build isolation", () => {
  it("removes inherited cloud and telemetry configuration without changing provider credentials or dev routing", () => {
    const inherited = {
      T3CODE_CLERK_PUBLISHABLE_KEY: "legacy-vendor-account",
      VITE_T3CODE_RELAY_URL: "https://legacy.invalid",
      DECKHAND_CLERK_PUBLISHABLE_KEY: "vendor-account",
      VITE_CLERK_PUBLISHABLE_KEY: "vendor-account",
      DECKHAND_RELAY_URL: "https://vendor.invalid",
      VITE_DECKHAND_RELAY_URL: "https://vendor.invalid",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "vendor-account",
      DECKHAND_RELAY_CLIENT_OTLP_TRACES_TOKEN: "vendor-token",
      DECKHAND_HOME: "/isolated/deckhand",
      OPENAI_API_KEY: "provider-key",
      DECKHAND_SINGLE_ORIGIN_DEV: "1",
    };
    const result = withoutUpstreamServices(inherited);
    expect(result.T3CODE_CLERK_PUBLISHABLE_KEY).toBe("");
    expect(result.VITE_T3CODE_RELAY_URL).toBe("");
    expect(result.DECKHAND_CLERK_PUBLISHABLE_KEY).toBe("");
    expect(result.VITE_CLERK_PUBLISHABLE_KEY).toBe("");
    expect(result.DECKHAND_RELAY_URL).toBe("");
    expect(result.VITE_DECKHAND_RELAY_URL).toBe("");
    expect(result.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBe("");
    expect(result.DECKHAND_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBe("");
    expect(result.DECKHAND_HOME).toBe("/isolated/deckhand");
    expect(result.OPENAI_API_KEY).toBe("provider-key");
    expect(result.DECKHAND_SINGLE_ORIGIN_DEV).toBe("1");
    expect(inherited.DECKHAND_CLERK_PUBLISHABLE_KEY).toBe("vendor-account");
  });
});
