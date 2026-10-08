import { describe, expect, it } from "vite-plus/test";

import { hasHostedPairingRequest, readHostedPairingRequest } from "./hostedPairing";

describe("hostedPairing", () => {
  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.abc.test/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      hasHostedPairingRequest(new URL("https://app.abc.test/pair?host=backend.example.com")),
    ).toBe(false);
    expect(hasHostedPairingRequest(new URL("https://app.abc.test/pair?token=ABCD1234"))).toBe(
      false,
    );
  });
});
