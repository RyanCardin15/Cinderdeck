import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { git } from "./upstream-maintenance.mjs";
const [reportPath, base] = process.argv.slice(2);
if (!reportPath || !base || !/^deckhand\/staging(?:[/-][A-Za-z0-9_.-]+)*$/.test(base))
  throw new Error("An explicit deckhand/staging branch is required");
const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
if (report.merge !== "clean" || report.conflicts.length)
  throw new Error("Conflicted updates need manual resolution; no staging branch pushed");
if (process.env.GITHUB_REPOSITORY?.toLowerCase() === "pingdotgg/t3code")
  throw new Error("Refusing upstream publication");
if (report.candidate === report.upstreamBaseline) {
  console.log("The pinned upstream revision is current; no review needed.");
  process.exit(0);
}
if (!/^[a-f0-9]{40}$/.test(report.candidate) || !/^[a-f0-9]{40}$/.test(report.source))
  throw new Error("The review report must pin immutable SHAs");
const worktree = report.worktree;
if (
  git(worktree, ["rev-parse", "HEAD"]) !== report.source ||
  git(worktree, ["diff", "--name-only", "--diff-filter=U"])
)
  throw new Error("The rehearsal source changed or still has conflicts");
const branch = `deckhand/upstream-${report.candidate.slice(0, 12)}`;
const existing = NodeChildProcess.execFileSync(
  "gh",
  ["pr", "list", "--head", branch, "--base", base, "--json", "url"],
  { cwd: worktree, encoding: "utf8" },
);
if (JSON.parse(existing).length > 0) {
  console.log("An upstream staging review already exists for this candidate.");
  process.exit(0);
}
if (!git(worktree, ["ls-remote", "--heads", "origin", `refs/heads/${base}`]))
  throw new Error("The configured staging branch does not exist");
const manifestPath = NodePath.resolve(worktree, "docs/deckhand/upstream-patches.json");
const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
manifest.upstreamRevision = report.candidate;
NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
git(worktree, ["checkout", "-b", branch]);
git(worktree, ["add", "docs/deckhand/upstream-patches.json"]);
git(worktree, [
  "-c",
  "user.name=Deckhand Upstream Staging",
  "-c",
  "user.email=upstream-staging@localhost",
  "commit",
  "-m",
  `chore(upstream): stage T3 ${report.candidate.slice(0, 12)}`,
]);
git(worktree, ["push", "origin", `HEAD:refs/heads/${branch}`]);
const bodyPath = NodePath.resolve(worktree, ".git-upstream-review-body.txt");
NodeFS.writeFileSync(
  bodyPath,
  `Stages T3 ${report.candidate} onto Deckhand ${report.source}, retaining both histories and Deckhand identity.\n\nThe text merge is clean. Compatibility remains unverified: all contracts, migration fixtures, provider scenarios, connected and standalone journeys, distribution identity, dependency changes and accessibility gates require evidence at the final merge commit before promotion.\n\nSee docs/deckhand/upstream-maintenance.md. This draft targets the staging branch; it does not publish or promote a release.\n`,
);
NodeChildProcess.execFileSync(
  "gh",
  [
    "pr",
    "create",
    "--draft",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    `Stage T3 update ${report.candidate.slice(0, 12)}`,
    "--body-file",
    bodyPath,
  ],
  { cwd: worktree, stdio: "inherit" },
);

NodeFS.unlinkSync(bodyPath);
