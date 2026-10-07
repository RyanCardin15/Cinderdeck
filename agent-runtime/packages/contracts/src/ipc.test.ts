import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("decodes the primary bootstrap", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("ignores the retired runningDistro field from older desktop builds", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }),
    ).toEqual({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: null,
      wsBaseUrl: null,
    });
  });
});
