import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
const source = NodeFS.readFileSync(new URL("./index.html", import.meta.url));
NodeFS.mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
NodeFS.writeFileSync(new URL("./dist/index.html", import.meta.url), source);
NodeFS.writeFileSync(
  new URL("./dist/stamp.json", import.meta.url),
  JSON.stringify({
    commit: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceHash: NodeCrypto.createHash("sha256").update(source).digest("hex"),
    builtAt: new Date().toISOString(),
  }),
);
