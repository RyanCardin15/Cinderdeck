// @effect-diagnostics nodeBuiltinImport:off
// Read-only inspection of an add-in project to tailor the two-line probe hook.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  EXCEL_PROBE_PATH,
  EXCEL_PROBE_SCRIPT_PATH,
  excelProbeSnippets,
  type ProbeSetup,
} from "@cinderdeck/contracts/deckhand/excelPerformance";

const fail = (reason: C.ExternalDebugError["reason"]) => new C.ExternalDebugError({ reason });
const read = (path: string) =>
  NodeFSP.readFile(path, "utf8").then(
    (text) => text.slice(0, 400_000),
    () => null,
  );
const CONFIGS = {
  webpack: ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"],
  vite: [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
  ],
} as const;
// Entries of the Yeoman Office generator and common React/Vite layouts.
const COMMON_ENTRIES = [
  "src/taskpane/taskpane.ts",
  "src/taskpane/taskpane.js",
  "src/taskpane/index.tsx",
  "src/taskpane/index.ts",
  "src/taskpane/index.jsx",
  "src/taskpane/index.js",
  "src/commands/commands.ts",
  "src/commands/commands.js",
  "src/main.tsx",
  "src/main.ts",
  "src/index.tsx",
  "src/index.ts",
];

export async function detectProbeSetup(projectRoot: string, port: number): Promise<ProbeSetup> {
  if (!NodePath.isAbsolute(projectRoot)) throw fail("invalid_command");
  const root = NodePath.resolve(projectRoot);
  const stat = await NodeFSP.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw fail("invalid_command");
  const pkg = await read(NodePath.join(root, "package.json"));
  let configFile: string | null = null;
  let configText = "";
  let bundler: ProbeSetup["bundler"] = "unknown";
  for (const [kind, names] of Object.entries(CONFIGS) as [
    keyof typeof CONFIGS,
    readonly string[],
  ][])
    for (const name of names) {
      const text = configFile ? null : await read(NodePath.join(root, name));
      if (text !== null) {
        configFile = name;
        configText = text;
        bundler = kind;
      }
    }
  if (bundler === "unknown" && pkg)
    bundler = /"vite"\s*:/.test(pkg)
      ? "vite"
      : /"webpack(-dev-server)?"\s*:/.test(pkg)
        ? "webpack"
        : "unknown";
  // Webpack entries name their source files directly; prefer those over guesses.
  const named = [...configText.matchAll(/["'`](\.\/[^"'`]+\.(?:[cm]?[jt]sx?))["'`]/g)]
    .map((match) => NodePath.normalize(match[1]!))
    .filter((path) => !/config|\.test\.|\.spec\./.test(path));
  const entryFiles: string[] = [];
  let loaderInstalled = false;
  for (const candidate of new Set([...named, ...COMMON_ENTRIES])) {
    if (entryFiles.length >= 20) break;
    const text = await read(NodePath.join(root, candidate));
    if (text === null) continue;
    entryFiles.push(candidate);
    if (text.includes(EXCEL_PROBE_SCRIPT_PATH)) loaderInstalled = true;
  }
  const manifests = (await NodeFSP.readdir(root).catch(() => [] as string[]))
    .filter((name) => /^manifest.*\.(xml|json)$/i.test(name))
    .slice(0, 20);
  const proxyConfigured = configText.includes(EXCEL_PROBE_PATH);
  const { proxySnippet, loaderSnippet } = excelProbeSnippets(bundler, port);
  const steps = [
    proxyConfigured
      ? null
      : `Add the dev-server proxy to ${configFile ?? "the dev server configuration"}.`,
    loaderInstalled
      ? null
      : `Add the loader as the first statement of each add-in page entry (${entryFiles.slice(0, 3).join(", ") || "the task pane entry"}), before code that calls Office.onReady or Excel.run.`,
    proxyConfigured && loaderInstalled
      ? "The probe hook is installed. Restart the dev server if the proxy was added while it was running, reload the add-in, then arm the probe."
      : "Restart the dev server and reload the add-in task pane. Both changes are development-only and inert when Cinderdeck is not running.",
    "Add performance.mark/measure (or __cinderdeckProbe.time(name, fn)) around validation and business steps to time them by name.",
  ].filter(Boolean);
  return {
    projectRoot: root,
    bundler,
    configFile,
    entryFiles,
    manifests,
    proxyConfigured,
    loaderInstalled,
    proxySnippet,
    loaderSnippet,
    instructions: steps.join("\n"),
  };
}
