import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { git, audit, rehearse, verifyEvidence, requiredGates } from "./upstream-maintenance.mjs";
function fixture(t) {
  const root = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "deckhand-upstream-NodeTest.test-"),
  );
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@localhost"]);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const manifest = {
    schemaVersion: 2,
    upstreamRevision: base,
    ownedPrefixes: ["docs/deckhand/"],
    upstreamEdits: { "shared.txt": "Keep Deckhand identity" },
    policies: [
      {
        owner: "Identity",
        files: ["shared.txt"],
        tests: ["proof.txt"],
        conflictResolution: "Retain Deckhand identity when adapting new upstream API",
      },
    ],
  };
  NodeFS.mkdirSync(NodePath.join(repo, "docs/deckhand"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(repo, "docs/deckhand/upstream-patches.json"),
    JSON.stringify(manifest),
  );
  NodeFS.writeFileSync(NodePath.join(repo, "proof.txt"), "fixture proof");
  manifest.upstreamEdits["proof.txt"] = "Maintenance fixture";
  manifest.policies[0].files.push("proof.txt");
  NodeFS.writeFileSync(
    NodePath.join(repo, "docs/deckhand/upstream-patches.json"),
    JSON.stringify(manifest),
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "Deckhand identity"]);
  const source = git(repo, ["rev-parse", "HEAD"]);
  return { root, repo, base, manifest, source };
}
NodeTest.test(
  "audit refuses unregistered patches, missing proof files and missing ownership",
  (t) => {
    const f = fixture(t);
    NodeAssert.equal(audit(f.repo, f.manifest).changedFiles, 2);
    NodeFS.writeFileSync(NodePath.join(f.repo, "unknown.txt"), "unregistered");
    NodeAssert.throws(() => audit(f.repo, f.manifest), /Unregistered upstream patch/);
    NodeFS.rmSync(NodePath.join(f.repo, "unknown.txt"));
    NodeFS.rmSync(NodePath.join(f.repo, "proof.txt"));
    NodeAssert.throws(() => audit(f.repo, f.manifest), /Missing focused proof/);
    NodeAssert.throws(() => audit(f.repo, { ...f.manifest, policies: [] }), /lacks ownership/);
  },
);
NodeTest.test(
  "clean candidate merge is isolated, retains both histories and cannot pass without evidence",
  (t) => {
    const f = fixture(t);
    git(f.repo, ["checkout", "--detach", f.base]);
    NodeFS.writeFileSync(NodePath.join(f.repo, "upstream.txt"), "new upstream feature");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-qm", "Upstream change"]);
    const candidate = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["checkout", "--detach", f.source]);
    const destination = NodePath.join(f.root, "rehearsal");
    const reportPath = NodePath.join(f.root, "report.json");
    const report = rehearse({
      repository: f.repo,
      candidate,
      source: f.source,
      destination,
      reportPath,
    });
    NodeAssert.equal(report.merge, "clean");
    NodeAssert.equal(report.promotionReady, false);
    NodeAssert.equal(git(f.repo, ["rev-parse", "HEAD"]), f.source);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(destination, "upstream.txt"), "utf8"),
      "new upstream feature",
    );
    NodeAssert.throws(() => verifyEvidence(report, destination));
    f.manifest.upstreamRevision = candidate;
    NodeFS.writeFileSync(
      NodePath.join(destination, "docs/deckhand/upstream-patches.json"),
      JSON.stringify(f.manifest),
    );
    git(destination, ["add", "."]);
    git(destination, ["commit", "-qm", "Reviewed upstream merge"]);
    const head = git(destination, ["rev-parse", "HEAD"]);
    const evidence = NodePath.join(f.root, "observed.json");
    NodeFS.writeFileSync(evidence, "{}");
    for (const gate of requiredGates)
      report.gates[gate] = { status: "passed", sourceCommit: head, evidence: [evidence] };
    NodeAssert.equal(verifyEvidence(report, destination).promotionReady, true);
    report.gates.providers.sourceCommit = f.source;
    NodeAssert.throws(() => verifyEvidence(report, destination), /Missing evidence for providers/);
  },
);
NodeTest.test(
  "real merge conflicts remain explicit and neither branch nor baseline is rewritten",
  (t) => {
    const f = fixture(t);
    NodeFS.writeFileSync(NodePath.join(f.repo, "shared.txt"), "Deckhand\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-qm", "Brand"]);
    const source = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["checkout", "--detach", f.base]);
    NodeFS.writeFileSync(NodePath.join(f.repo, "shared.txt"), "T3 update\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-qm", "Upstream brand"]);
    const candidate = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["checkout", "--detach", source]);
    const report = rehearse({
      repository: f.repo,
      source,
      candidate,
      destination: NodePath.join(f.root, "conflict"),
      reportPath: NodePath.join(f.root, "report.json"),
    });
    NodeAssert.deepEqual(report.conflicts, ["shared.txt"]);
    NodeAssert.equal(report.merge, "conflicted");
    NodeAssert.equal(git(f.repo, ["rev-parse", "HEAD"]), source);
    NodeAssert.throws(() => verifyEvidence(report, f.repo), /Unresolved/);
  },
);
NodeTest.test("mutable refs and reuse of existing worktrees are rejected before mutation", (t) => {
  const f = fixture(t);
  NodeAssert.throws(
    () =>
      rehearse({
        repository: f.repo,
        source: f.source,
        candidate: "upstream/main",
        destination: NodePath.join(f.root, "new"),
        reportPath: NodePath.join(f.root, "report.json"),
      }),
    /immutable/,
  );
  NodeAssert.throws(
    () =>
      rehearse({
        repository: f.repo,
        source: f.source,
        candidate: f.base,
        destination: f.repo,
        reportPath: NodePath.join(f.root, "report.json"),
      }),
    /new absolute path/,
  );
});
