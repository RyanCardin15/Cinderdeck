import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:CinderdeckTools/cinderdeck.git", "CinderdeckTools/cinderdeck"],
  ["github.com:CinderdeckTools/cinderdeck.git", "CinderdeckTools/cinderdeck"],
  ["gitlab.com:CinderdeckTools/platform/cinderdeck", "CinderdeckTools/platform/cinderdeck"],
  ["https://github.com/CinderdeckTools/cinderdeck.git", "CinderdeckTools/cinderdeck"],
  ["https://github.com/CinderdeckTools/cinderdeck.git?view=compact", "CinderdeckTools/cinderdeck"],
  ["https://github.com/CinderdeckTools/cinderdeck.git#section", "CinderdeckTools/cinderdeck"],
  ["C:/repos/cinderdeck", null],
])("reads the repository path of %s", (remoteUrl, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
});
