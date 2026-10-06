// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import { makeNativeComputerUse } from "./ComputerUseNative.ts";

let directory: string;
let call: ReturnType<typeof makeNativeComputerUse>;
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "computer-use-transport-"));
  const helper = NodePath.join(directory, "helper");
  await NodeFSP.writeFile(
    helper,
    `#!${process.execPath}
const readline = require("node:readline");
console.log("ignored malformed line");
console.log(JSON.stringify({ready:true}));
readline.createInterface({input:process.stdin}).on("line", line => {
  const {id,method,params} = JSON.parse(line);
  if (method === "hang") return;
  if (method === "error") console.log(JSON.stringify({id,error:"element_missing",detail:"Read fresh state"}));
  else console.log(JSON.stringify({id,result:{pid:process.pid,method,params}}));
});
`,
    { mode: 0o700 },
  );
  call = makeNativeComputerUse({ helperPath: () => helper });
});
afterEach(async () => {
  call?.dispose();
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

describe.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
  "computer use native transport",
  () => {
    it("multiplexes concurrent calls through one persistent helper", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, id) => call("echo", { id })),
      );
      expect(new Set(results.map((row) => row.pid)).size).toBe(1);
      expect(results.map((row) => (row.params as { id: number }).id)).toEqual(
        Array.from({ length: 20 }, (_, id) => id),
      );
    });

    it("preserves actionable native errors", async () => {
      await expect(call("error")).rejects.toMatchObject({
        reason: "element_missing",
        detail: "Read fresh state",
      });
    });

    it("terminates a timed-out helper and starts a fresh one", async () => {
      const first = await call("echo");
      await expect(call("hang", {}, 20)).rejects.toMatchObject({ reason: "timeout" });
      const next = await call("echo");
      expect(next.pid).not.toBe(first.pid);
    });

    it("caps the queue even when calls arrive during startup", async () => {
      const requests = Array.from({ length: 80 }, () => call("hang", {}, 30));
      const outcomes = await Promise.allSettled(requests);
      expect(
        outcomes.filter(
          (result) => result.status === "rejected" && result.reason.reason === "busy",
        ),
      ).toHaveLength(16);
    });
  },
);
