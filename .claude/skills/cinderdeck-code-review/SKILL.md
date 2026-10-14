---
name: cinderdeck-code-review
description: Review committed changes in a Cinderdeck session, using an optional Git worktree to keep the source checkout untouched.
---

Review the committed changes against the intended base branch in each repository with changes under review.
Inspect which repositories changed before choosing review folders. Reuse a suitable existing
checkout when reading code. If checks need separate files, use an ordinary Git worktree for
each repository under review and keep other repositories as read-only context.
In the current session, use `t3_worktree_handoff`; use `adoptExisting` with an absolute path
and matching branch to select an existing worktree. Supply a self-contained `continuationPrompt`
with the review goal, findings and constraints to resume after the provider detaches.
Use `t3_thread_launch` only when the user asks for a separate conversation, with a `worktree`
or `existing_worktree` workspace strategy. Omit the retired `repositoryModes` field.
Worktrees do not automatically allocate service ports. Inspect `workspace_details` for the
configured services and run checks from the actual review folder.
Read repository instructions and the surrounding code before assessing a change.
Determine the base from the pull request or repository's default branch; if ambiguous, ask.
Find actionable correctness bugs, regressions, security issues, and missing tests.
Prioritize findings by impact and include exact file and line references, a concrete trigger,
and an explanation of the observed or expected failure. Avoid speculative style complaints.
Run focused checks when useful and distinguish verified behavior from untested assumptions.
Report findings first, followed by a brief assessment and validation limits. Say when none are found.
Keep source checkouts untouched. Do not publish a review, create a pull request, or merge.
