import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const shaPattern = /^[a-f0-9]{40}$/;
export const requiredGates = [
  "contracts",
  "migrations",
  "providers",
  "connectedJourney",
  "standaloneJourney",
  "identity",
  "dependencies",
  "accessibility",
];
export function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function patchPolicy(manifest, path) {
  if (manifest.ownedPrefixes.some((prefix) => path.startsWith(prefix))) return null;
  if (!Object.hasOwn(manifest.upstreamEdits, path))
    throw new Error(`Unregistered upstream patch: ${path}`);
  const policy = manifest.policies?.find((policy) => policy.files.includes(path));
  if (!policy || !policy.owner || !policy.conflictResolution || !policy.tests?.length)
    throw new Error(`Patch lacks ownership, tests or conflict resolution: ${path}`);
  if (!String(manifest.upstreamEdits[path]).trim())
    throw new Error(`Patch lacks a reason: ${path}`);
  return policy;
}
export function audit(repository, manifest) {
  if (manifest.schemaVersion !== 2 || !shaPattern.test(manifest.upstreamRevision))
    throw new Error("Invalid patch manifest");
  git(repository, ["cat-file", "-e", `${manifest.upstreamRevision}^{commit}`]);
  const changed = new Set(
    [
      ...git(repository, ["diff", "--name-only", "-z", manifest.upstreamRevision]).split("\0"),
      ...git(repository, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean),
  );
  for (const path of new Set([...changed, ...Object.keys(manifest.upstreamEdits)])) {
    const policy = patchPolicy(manifest, path);
    for (const test of policy?.tests ?? [])
      if (!NodeFS.existsSync(NodePath.resolve(repository, test)))
        throw new Error(`Missing focused proof ${test} for ${path}`);
  }
  return {
    upstreamRevision: manifest.upstreamRevision,
    changedFiles: changed.size,
    patchedUpstreamFiles: [...changed].filter(
      (path) => !manifest.ownedPrefixes.some((prefix) => path.startsWith(prefix)),
    ).length,
  };
}
export function rehearse({ repository, candidate, source, destination, reportPath }) {
  if (!shaPattern.test(candidate) || !shaPattern.test(source))
    throw new Error("Candidate and fork source must be full immutable commit SHAs");
  if (!NodePath.isAbsolute(destination) || NodeFS.existsSync(destination))
    throw new Error("Rehearsal destination must be a new absolute path");
  const manifest = JSON.parse(
    git(repository, ["show", `${source}:docs/deckhand/upstream-patches.json`]),
  );
  git(repository, ["merge-base", "--is-ancestor", manifest.upstreamRevision, candidate]);
  git(repository, ["merge-base", "--is-ancestor", manifest.upstreamRevision, source]);
  git(repository, ["worktree", "add", "--detach", destination, source]);
  const merge = NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "user.name=Deckhand Upstream Rehearsal",
      "-c",
      "user.email=upstream-rehearsal@localhost",
      "merge",
      "--no-commit",
      "--no-ff",
      candidate,
    ],
    { cwd: destination, encoding: "utf8" },
  );
  const conflicts = git(destination, ["diff", "--name-only", "--diff-filter=U", "-z"])
    .split("\0")
    .filter(Boolean);
  if (merge.status !== 0 && conflicts.length === 0)
    throw new Error(`Merge failed before conflict review: ${merge.stderr}`);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source,
    upstreamBaseline: manifest.upstreamRevision,
    candidate,
    worktree: destination,
    sourceIncludesUncommittedChanges: false,
    merge: conflicts.length ? "conflicted" : "clean",
    conflicts,
    upstreamCommits: Number(
      git(repository, ["rev-list", "--count", `${manifest.upstreamRevision}..${candidate}`]),
    ),
    gates: Object.fromEntries(
      requiredGates.map((gate) => [gate, { status: "pending", evidence: [] }]),
    ),
    promotionReady: false,
  };
  NodeFS.mkdirSync(NodePath.dirname(reportPath), { recursive: true });
  NodeFS.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
export function verifyEvidence(report, repository) {
  if (
    report.merge !== "clean" ||
    report.conflicts.length ||
    !shaPattern.test(report.candidate) ||
    !shaPattern.test(report.source)
  )
    throw new Error("Unresolved or invalid upstream rehearsal");
  git(repository, ["merge-base", "--is-ancestor", report.candidate, "HEAD"]);
  git(repository, ["merge-base", "--is-ancestor", report.source, "HEAD"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const manifest = JSON.parse(
    NodeFS.readFileSync(
      NodePath.resolve(repository, "docs/deckhand/upstream-patches.json"),
      "utf8",
    ),
  );
  if (manifest.upstreamRevision !== report.candidate)
    throw new Error("Patch baseline must match reviewed candidate");
  audit(repository, manifest);
  for (const gate of requiredGates) {
    const proof = report.gates[gate];
    if (proof?.status !== "passed" || proof.sourceCommit !== head || !proof.evidence?.length)
      throw new Error(`Missing evidence for ${gate} at ${head}`);
    for (const path of proof.evidence)
      if (!NodePath.isAbsolute(path) || !NodeFS.existsSync(path))
        throw new Error(`Evidence artifact not found: ${path}`);
  }
  return { promotionReady: true, sourceCommit: head, candidate: report.candidate };
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  const repository = process.cwd();
  if (command === "audit") {
    console.log(
      JSON.stringify(
        audit(
          repository,
          JSON.parse(NodeFS.readFileSync("docs/deckhand/upstream-patches.json", "utf8")),
        ),
        null,
        2,
      ),
    );
  } else if (command === "rehearse" && args.length === 4) {
    console.log(
      JSON.stringify(
        rehearse({
          repository,
          candidate: args[0],
          source: args[1],
          destination: args[2],
          reportPath: NodePath.resolve(args[3]),
        }),
        null,
        2,
      ),
    );
  } else if (command === "verify" && args.length === 1) {
    console.log(
      JSON.stringify(
        verifyEvidence(JSON.parse(NodeFS.readFileSync(args[0], "utf8")), repository),
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Usage: node scripts/deckhand/upstream-maintenance.mjs audit | rehearse <candidate-sha> <fork-sha> <new-absolute-worktree> <report.json> | verify <report.json>",
    );
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
