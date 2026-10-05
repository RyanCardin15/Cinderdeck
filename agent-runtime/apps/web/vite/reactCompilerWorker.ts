// Worker half of reactCompilerWorkers.ts: one Babel React Compiler transform per message.
// Plain Node runs this file, so it may only use erasable TypeScript syntax.
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";

import type * as Babel from "@babel/core";

import type {
  ReactCompilerJob,
  ReactCompilerResult,
  ReactCompilerWorkerData,
} from "./reactCompilerWorkers.ts";

// The same Babel that @rolldown/plugin-babel (the dev-server path) loads.
// @types/babel__core predates loadOptionsAsync, which Babel 7.8+ provides.
const babel = NodeModule.createRequire(import.meta.resolve("@rolldown/plugin-babel"))(
  "@babel/core",
) as typeof Babel & {
  loadOptionsAsync(options: Babel.TransformOptions): Promise<Babel.TransformOptions | null>;
};

const port = NodeWorkerThreads.parentPort;
if (!port) throw new Error("reactCompilerWorker must run in a worker thread.");
const data = NodeWorkerThreads.workerData as ReactCompilerWorkerData;
// Babel caches instantiated plugins by preset identity, so build these once.
const preset = () => data.preset;
const include = data.include.map((source) => new RegExp(source));
const exclude = data.exclude.map((source) => new RegExp(source));

// Mirrors the options @rolldown/plugin-babel passes for
// babel({ parserOpts: { plugins: ["typescript", "jsx"] }, presets: [reactCompilerPreset()] }).
async function transform({ code, id }: ReactCompilerJob) {
  const options = await babel.loadOptionsAsync({
    include,
    exclude,
    sourceMaps: true,
    presets: [preset],
    babelrc: false,
    configFile: false,
    parserOpts: {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      plugins: ["typescript", "jsx"],
    },
    overrides: [
      { test: /\.jsx(?:$|\?)/, parserOpts: { plugins: ["jsx"] } },
      { test: /\.ts(?:$|\?)/, parserOpts: { plugins: ["typescript"] } },
      { test: /\.tsx(?:$|\?)/, parserOpts: { plugins: ["typescript", "jsx"] } },
    ],
    filename: id,
  });
  if (!options || (options.plugins?.length ?? 0) === 0) return {};
  const result = await babel.transformAsync(code, options);
  return result ? { code: result.code ?? undefined, map: result.map ?? undefined } : {};
}

port.on("message", (job: ReactCompilerJob) => {
  transform(job).then(
    (output) => {
      const result: ReactCompilerResult = { seq: job.seq, ...output };
      port.postMessage(result);
    },
    (cause: unknown) => {
      const error = cause as {
        message?: string;
        loc?: { line: number; column: number };
        pos?: number;
        code?: string;
        reasonCode?: string;
      };
      const result: ReactCompilerResult = {
        seq: job.seq,
        error: {
          message: error.message ?? String(cause),
          loc: error.loc,
          pos: error.pos,
          pluginCode: `${error.code}:${error.reasonCode}`,
        },
      };
      port.postMessage(result);
    },
  );
});
