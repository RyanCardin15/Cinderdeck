// @effect-diagnostics nodeBuiltinImport:off -- This middleware integration test owns a disposable native HTTP listener.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP_RENDERER_ACCESS_HEADER } from "@cinderdeck/shared/desktopRendererAccess";
import { desktopRendererMiddleware } from "./desktopRenderer.ts";

describe("desktop development renderer", () => {
  it("blocks direct browser requests while serving the desktop protocol proxy", async () => {
    const token = "private-renderer-fixture-token-with-32-characters";
    const middleware = desktopRendererMiddleware(token);
    const server = NodeHttp.createServer((request, response) => {
      middleware(request, response, () => {
        response.end("private desktop renderer fixture");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      for (const path of [
        "/",
        "/settings",
        "/@vite/client",
        "/src/main.tsx",
        `/index.html?token=${token}`,
      ]) {
        const direct = await fetch(`${origin}${path}`);
        expect(direct.status).toBe(404);
        expect(direct.headers.get("cache-control")).toBe("no-store");
        expect(await direct.text()).not.toContain("private desktop renderer fixture");
      }
      const spoofed = await fetch(origin, {
        headers: {
          origin: "deckhand-dev://app",
          "user-agent": "Electron",
          [DESKTOP_RENDERER_ACCESS_HEADER]: "wrong",
        },
      });
      expect(spoofed.status).toBe(404);
      const desktop = await fetch(`${origin}/src/main.tsx`, {
        headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: token },
      });
      expect(desktop.status).toBe(200);
      expect(await desktop.text()).toBe("private desktop renderer fixture");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
