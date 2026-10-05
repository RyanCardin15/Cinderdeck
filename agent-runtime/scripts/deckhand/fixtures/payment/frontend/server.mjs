import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
const api = process.env.CINDERDECK_URL_API || "http://127.0.0.1:47862";
const server = NodeHttp.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      const response = await fetch(api + req.url.slice(4));
      res.statusCode = response.status;
      res.setHeader("Content-Type", "application/json");
      return res.end(await response.text());
    }
    if (req.url === "/stamp") {
      res.setHeader("Content-Type", "application/json");
      return res.end(NodeFS.readFileSync(new URL("./dist/stamp.json", import.meta.url)));
    }
    res.setHeader("Content-Type", "text/html");
    res.end(NodeFS.readFileSync(new URL("./dist/index.html", import.meta.url)));
  } catch {
    res.statusCode = 503;
    res.end("Fixture unavailable");
  }
});
server.listen(Number(process.env.PORT || 47861), "127.0.0.1", () => console.log("FRONTEND READY"));
