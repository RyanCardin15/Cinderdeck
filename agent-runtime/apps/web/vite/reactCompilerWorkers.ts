import * as NodeOS from "node:os";
import * as NodeWorkerThreads from "node:worker_threads";

import { reactCompilerPreset } from "@vitejs/plugin-react";
import type { Plugin } from "vite-plus";

export interface ReactCompilerWorkerData {
  readonly preset: unknown;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}
export interface ReactCompilerJob {
  readonly seq: number;
  readonly code: string;
  readonly id: string;
}
export interface ReactCompilerResult {
  readonly seq: number;
  readonly code?: string | undefined;
  readonly map?: unknown;
  readonly error?: {
    readonly message: string;
    readonly loc?: { line: number; column: number } | undefined;
    readonly pos?: number | undefined;
    readonly pluginCode: string;
  };
}

// @rolldown/plugin-babel's defaults, so both paths compile the same modules.
const INCLUDE = /\.(?:[jt]sx?|[cm][jt]s)(?:$|\?)/;
const EXCLUDE = /[/\\]node_modules[/\\]|^\0rolldown\/runtime\.js$/;

class WorkerPool {
  private readonly idle: NodeWorkerThreads.Worker[] = [];
  private readonly busy = new Map<NodeWorkerThreads.Worker, number>();
  private readonly queue: ReactCompilerJob[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (result: ReactCompilerResult) => void; reject: (error: unknown) => void }
  >();
  private seq = 0;
  private failure: unknown;

  constructor(size: number, workerData: ReactCompilerWorkerData) {
    for (let index = 0; index < size; index += 1) {
      const worker = new NodeWorkerThreads.Worker(
        new URL("./reactCompilerWorker.ts", import.meta.url),
        { workerData },
      );
      // Only busy workers keep the process alive, so a build that never
      // reaches buildEnd cannot hang on an idle pool.
      worker.unref();
      worker.on("message", (result: ReactCompilerResult) => {
        this.busy.delete(worker);
        this.pending.get(result.seq)?.resolve(result);
        this.pending.delete(result.seq);
        this.release(worker);
      });
      worker.on("error", (error) => this.fail(error));
      worker.on("exit", (code) => {
        if (code !== 0) this.fail(new Error(`React Compiler worker exited with code ${code}.`));
      });
      this.idle.push(worker);
    }
  }

  run(code: string, id: string): Promise<ReactCompilerResult> {
    if (this.failure) return Promise.reject(this.failure);
    const job = { seq: (this.seq += 1), code, id };
    const result = new Promise<ReactCompilerResult>((resolve, reject) => {
      this.pending.set(job.seq, { resolve, reject });
    });
    const worker = this.idle.pop();
    if (worker) this.dispatch(worker, job);
    else this.queue.push(job);
    return result;
  }

  async close() {
    const workers = [...this.idle, ...this.busy.keys()];
    this.idle.length = 0;
    this.busy.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  private dispatch(worker: NodeWorkerThreads.Worker, job: ReactCompilerJob) {
    this.busy.set(worker, job.seq);
    worker.ref();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage(job);
  }

  private release(worker: NodeWorkerThreads.Worker) {
    const next = this.queue.shift();
    if (next) return this.dispatch(worker, next);
    worker.unref();
    this.idle.push(worker);
  }

  private fail(error: unknown) {
    this.failure ??= error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.queue.length = 0;
  }
}

/**
 * Production builds run the React Compiler on a pool of worker threads. On
 * the main thread, @rolldown/plugin-babel's single-threaded Babel pass was
 * about 80% of `vp build`. The dev server keeps that plugin; this one uses the
 * same preset, filters and Babel options, so build output is unchanged.
 */
export function reactCompilerWorkers(): Plugin {
  const preset = reactCompilerPreset();
  // The preset is a factory of plain plugin options, which workers can receive.
  if (typeof preset.preset !== "function") throw new Error("Unexpected React Compiler preset.");
  const workerData: ReactCompilerWorkerData = {
    preset: (preset.preset as () => unknown)(),
    include: [INCLUDE.source],
    exclude: [EXCLUDE.source],
  };
  const codeFilter = preset.rolldown.filter?.code;
  let pool: WorkerPool | undefined;
  const closePool = async () => {
    const current = pool;
    pool = undefined;
    await current?.close();
  };
  return {
    name: "deckhand:react-compiler-workers",
    apply: "build",
    enforce: "pre",
    applyToEnvironment: (environment) =>
      preset.rolldown.applyToEnvironmentHook?.(environment) ?? true,
    transform: {
      filter: {
        id: { include: [INCLUDE], exclude: [EXCLUDE] },
        ...(codeFilter === undefined ? {} : { code: codeFilter }),
      },
      async handler(code, id) {
        pool ??= new WorkerPool(
          Math.max(1, Math.min(NodeOS.availableParallelism() - 1, 8)),
          workerData,
        );
        const result = await pool.run(code, id);
        const { error } = result;
        if (error) {
          this.error({
            message: `[BabelError] ${error.message}`,
            pluginCode: error.pluginCode,
            ...(error.loc ? { loc: error.loc } : {}),
            ...(error.pos === undefined ? {} : { pos: error.pos }),
          });
        }
        if (result.code === undefined) return;
        return { code: result.code, map: result.map as never };
      },
    },
    buildEnd: closePool,
  };
}
