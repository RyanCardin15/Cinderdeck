import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--root" || !NodePath.isAbsolute(args[1]))
  throw new Error("Usage: node scripts/deckhand/create-fixture.mjs --root /absolute/new/directory");
const root = NodePath.resolve(args[1]);
NodeFS.mkdirSync(root, { recursive: false });
NodeFS.cpSync(new URL("./fixtures/payment/", import.meta.url), root, { recursive: true });
for (const repo of ["frontend", "api", "shared"]) {
  const cwd = NodePath.join(root, repo);
  NodeFS.writeFileSync(NodePath.join(cwd, ".gitignore"), "dist/\n");
  for (const gitArgs of [
    ["init", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=Deckhand Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Initial payment scenario",
    ],
  ])
    NodeChildProcess.execFileSync("git", gitArgs, { cwd, stdio: "ignore" });
}
NodeChildProcess.execFileSync(process.execPath, ["build.mjs"], {
  cwd: NodePath.join(root, "frontend"),
  stdio: "ignore",
});
const q = (s) => JSON.stringify(s);
const shellQuote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const nodeCommand = shellQuote(process.execPath);
NodeFS.writeFileSync(
  NodePath.join(root, "payment.toml"),
  `name = "Deckhand payment fixture"\nroot = ${q(root)}\n\n[repos.frontend]\npath = "frontend"\n[repos.api]\npath = "api"\n[repos.shared]\npath = "shared"\n\n[services.api]\nrepo = "api"\ncmd = ${q(nodeCommand + " server.mjs")}\nport = 47862\nready.log = "API READY"\n[services.web]\nrepo = "frontend"\ncmd = ${q(nodeCommand + " build.mjs && " + nodeCommand + " server.mjs")}\nport = 47861\ndepends_on = ["api"]\nready.log = "FRONTEND READY"\n\n[tasks.verify]\nrepo = "frontend"\ncmd = ${q(nodeCommand + " check.mjs")}\n\n[workflows.verify]\nsteps = ["task:verify"]\n\n[lanes]\nfrom = "main"\n`,
);
process.stdout.write(
  JSON.stringify({
    root,
    repositories: ["frontend", "api", "shared"].map((repo) => NodePath.join(root, repo)),
    definition: NodePath.join(root, "payment.toml"),
  }) + "\n",
);
