import * as NodeFS from "node:fs";
import { audit } from "./upstream-maintenance.mjs";
const result = audit(
  process.cwd(),
  JSON.parse(
    NodeFS.readFileSync(
      new URL("../../docs/deckhand/upstream-patches.json", import.meta.url),
      "utf8",
    ),
  ),
);
console.log(
  `Patch boundary verified: ${result.changedFiles} files (${result.patchedUpstreamFiles} upstream patches); upstream ${result.upstreamRevision}.`,
);
