// @effect-diagnostics nodeBuiltinImport:off
// Runs before any Effect runtime exists, so it stays on Node built-ins.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Turns on Node's on-disk V8 code cache for every module loaded after this one,
// so later launches skip recompiling the large main and server bundles.
// Packaged builds only: boot.ts loads it for the main process, and the local
// backend gets it with `--require`. Dev launches main.cjs directly and skips it.
// The macOS temp dir is already per user.
try {
  NodeModule.enableCompileCache(NodePath.join(NodeOS.tmpdir(), "deckhand", "compile-cache"));
} catch {
  // The cache is only a speedup. Never let it stop the app from starting.
}
