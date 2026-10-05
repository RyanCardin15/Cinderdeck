import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
const scenario = JSON.parse(
  NodeFS.readFileSync(new URL("../shared/scenario.json", import.meta.url), "utf8"),
);
const source = NodeFS.readFileSync(new URL("./server.mjs", import.meta.url));
const stamp = {
  commit: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHash: NodeCrypto.createHash("sha256").update(source).digest("hex"),
  scenario,
};
const fixed = process.env.FIXTURE_PAYMENT_RETRY_FIX === "1";
const server = NodeHttp.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/stamp") return res.end(JSON.stringify(stamp));
  if (req.url === "/health") return res.end(JSON.stringify({ ready: true }));
  if (req.url?.startsWith("/payment")) {
    const retry = new URL(req.url, "http://fixture").searchParams.get("retry") === "1";
    const result = retry && fixed ? scenario.retryResult : scenario.firstResult;
    console.log(
      JSON.stringify({
        scenario: scenario.id,
        event: retry ? "payment.retry" : "payment.submit",
        result,
        at: Date.now(),
      }),
    );
    res.statusCode = result === "paid" ? 200 : 402;
    return res.end(JSON.stringify({ scenario: scenario.id, result, stamp }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(Number(process.env.PORT || 47862), "127.0.0.1", () => console.log("API READY"));
