import {
  DESKTOP_RENDERER_ACCESS_HEADER,
  hasDesktopRendererAccess,
} from "@cinderdeck/shared/desktopRendererAccess";
import type { Connect, Plugin } from "vite-plus";

export function desktopRendererMiddleware(token: string | undefined): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (hasDesktopRendererAccess(token, request.headers[DESKTOP_RENDERER_ACCESS_HEADER])) {
      next();
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end("Open Cinderdeck in the macOS application.");
  };
}

/** Only Electron's private protocol proxy may load development UI files. */
export function desktopRendererPlugin(token: string | undefined): Plugin {
  return {
    name: "cinderdeck:desktop-renderer",
    apply: "serve",
    configureServer(server) {
      // Installed before Vite's static files, transforms, and API proxies.
      server.middlewares.use(desktopRendererMiddleware(token));
    },
  };
}
