---
name: cinderdeck-code-review
description: Review committed changes in an isolated Cinderdeck lane.
---

Review the committed changes against the intended base branch in each repository with changes under review.
When creating a review lane, inspect which repositories changed first. If only one of four
repositories has changes, create a worktree only for that repository and select Reference
for the other three (MCP repositoryModes, CLI --repo-mode). Use their primary checkouts
as read-only context; do not edit them or run checks that modify their files.
Supply repositoryRefs only for repositories selected as worktrees.
Read repository instructions and the surrounding code before assessing a change.
Determine the base from the pull request or repository's default branch; if ambiguous, ask.
Find actionable correctness bugs, regressions, security issues, and missing tests.
Prioritize findings by impact and include exact file and line references, a concrete trigger,
and an explanation of the observed or expected failure. Avoid speculative style complaints.
Run focused checks when useful and distinguish verified behavior from untested assumptions.
Report findings first, followed by a brief assessment and validation limits. Say when none are found.
Keep source checkouts untouched. Do not publish a review, create a pull request, or merge.
