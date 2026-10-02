# Lane audit and validation — October 2, 2026

Lanes support running feature branches alongside the original workspace, adopting
agent worktrees, and running tasks against the lane's own services. This audit
fixed lifecycle and panel gaps in those flows. The changes were validated in the
local checkout.

## Fixes

| Flow | Result |
| --- | --- |
| Create or adopt through the panel | Choose New worktree or Existing worktree; adoption offers a folder picker and optional name. Setup defaults off for adoption. Both use the same control API as CLI/MCP and show setup/start failures. |
| Open an adopted or shared lane | Cards show actual repository paths. Open targets those repositories in Finder or an editor, with separate choices for multiple repositories. Cards and controls remain visible. |
| Adopt with a custom name | The name changes the lane's address; other repositories use the adopted worktree's actual branch. |
| Share an adopted worktree across workspaces | Borrowing keeps its external ownership, so removing its last lane cannot delete the worktree. |
| Release a shared managed worktree | Ownership is relinquished in remaining lane records, preventing later deletion of the released files. |
| Remove shared worktrees with copied configuration | Cleanup metadata follows every borrower until the last lane is removed. |
| Remove copied files and links | Unchanged individual copies and links are cleaned up even when untracked. Changed copies, replaced links, and directory copies require explicit discard. Tracked changes remain protected. |
| Remove a lane with teardown | Local changes and running dependents are checked first, services stop before teardown, and removal reserves the lane while teardown runs. A failed teardown leaves the stopped lane available for repair. |
| Create while setup runs | The new lane is claimed before setup starts. |
| Agent control coverage | MCP adoption accepts `env`, `from` and `copy`, matching the lane CLI; release accepts `delete_logs`. The lane skill and help cover detached worktrees, name/environment edits, actual repository folders and service-specific exports. |

## Verification

- The original 39 lane tests passed. Seven added regression cases failed on the
  original implementation, reproducing ownership, cleanup, branch-selection, and
  teardown problems.
- The final Debug build passed **93 tests with zero failures**, including **48
  lane tests**. The other suites cover workspace runs, claims/control, MCP,
  navigation, definition editing, and bundled agent skills.
- The agent coverage follow-up passed **15 focused MCP and bundled-skill tests**,
  including a new regression for adoption/release argument parity and invalid
  argument types. Compiled CLI help and tool schemas matched the real MCP stdio
  catalog and initialization guidance.
- `scripts/lanes-e2e.py --inspect` passed against the final Debug app, its control
  socket, CLI, MCP, throwaway Git repositories, and real HTTP services. Five
  environments ran with distinct ports/worktrees/claims, including simultaneous
  creation requests. A workflow reached its own lane server. Setup copied
  configuration, teardown verified stopped services, and cleanup preserved the
  source and sibling processes and Git branches. An adopted worktree shared by
  two workspaces survived both lane removals.
- Native panel checks created a feature lane and adopted a custom-named worktree.
  Finder opened the adopted repository with the expected files. The final layout
  showed complete lane cards and their folder controls. A separate integration
  test ran and released a detached agent worktree while preserving its edits.
- Agent skill copies match their canonical source; `git diff --check` passes.

Local evidence is in `.build/lanes-audit-final.log`,
`.build/lanes-audit-e2e-final.log`, and `.build/lanes-audit-ui.txt`. Fixtures and
their processes were cleaned up. The unrelated signing and voice-design work
present before this audit was preserved.

## Common usage

Select the workspace and open **Lanes**. Use **New worktree** for another branch,
or **Existing worktree** for a checkout an agent or editor already created.
Enable setup for dependency installation, then start the lane's services. Use the
displayed URLs or `lane env` when testing; open the repository through its card.

Use distinct branches for independent edits. Workspaces using the same repository
and branch share files even though their services and ports are separate. Stop
dependent lanes before removing a backend lane. Release a lane to keep working in
its worktrees; remove it to clean managed worktrees after reviewing local files.

Configuration, CLI examples, and templates are documented in
[Parallel worktree lanes](STACKS.md#parallel-worktree-lanes).
