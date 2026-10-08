import { assert, it } from "@effect/vitest";
import { formatCliCommand } from "./invocation.ts";

it("uses the exact private runtime entry rather than a package runner", () => {
  for (const version of ["1.0.0", "1.0.0-nightly.1", "1.0.0-preview.1"]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath: "/tmp/runtime/bin.mjs", version }),
      "node '/tmp/runtime/bin.mjs' serve",
    );
  }
});
it("quotes an entry path containing shell metacharacters", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "pair",
      entryPath: "/tmp/it's $(unsafe)/bin.mjs",
      version: "1.0.0",
    }),
    "node '/tmp/it'\\''s $(unsafe)/bin.mjs' pair",
  );
});
it("provides the local source entry only when no entry was supplied", () => {
  assert.equal(
    formatCliCommand({ subcommand: "serve", entryPath: "", version: "1.0.0" }),
    "node 'apps/server/src/bin.ts' serve",
  );
});
