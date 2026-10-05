# Set up Cinderdeck

Install the complete Cinderdeck app and open its main window. The native host supplies the local runtime connection. For connected work, start Cinderdeck on that execution computer, then choose **Connect to Cinderdeck** during setup or **Settings → Integrations → Cinderdeck**. Inspect the reported installation and workspace before opening it. For a remote computer, this connects to that computer’s Cinderdeck; it does not use the browser viewer’s local app.

Sign in to your selected provider in **Settings → Providers**. Cinderdeck uses the provider’s existing CLI and authentication flow. Provider credentials stay on the execution host. Choose a configured account and model before starting work. The native host owns workspace services and lanes; its embedded shell owns conversations and feature context.

The installed app stores agent state in `AgentRuntime` below the native control directory, with the Electron profile in `Profile`. Cinderdeck does not open or migrate a legacy agent database automatically. For an isolated development server, pass an explicit `--home-dir`; `DECKHAND_HOME` and `DECKHAND_PROFILE_ROOT` remain internal compatibility overrides.

## Browse GitHub pull requests

Open **Settings → Source Control → GitHub account** to configure GitHub on the execution computer. **Pull requests** uses that account directly; you do not need to preload a workspace. Your existing Cinderdeck saved queries and selected view carry over. Choose **My work**, an organization, or a repository, and use GitHub stars as favorites. Saved-view edits are shared with the original Cinderdeck pull request browser.

## Troubleshoot a connection

Use **Check connection** to refresh native discovery, installation identity, protocol and capabilities. A changed installation, missing workspace or stale generation requires a deliberate current-workspace selection. Inspect the saved operation using **Check status** after a lost reply; reuse its original operation key. Restarting or creating replacement work is not evidence that the earlier operation failed.

A provider can retain checkout ownership between turns. Use **Stop writer and release** for that specific conversation before running a conflicting native build or review. The transcript and lane remain available. Shared or uncertain ownership is refused until it can be reconciled safely.

## Prepare a local support report

From the runtime source, run `node apps/server/dist/bin.mjs diagnostics` for an offline structural JSON report. To save it, choose a new filename in an existing directory:

```sh
node apps/server/dist/bin.mjs diagnostics --base-dir /absolute/deckhand-root --output /absolute/new-report.json
node apps/server/dist/bin.mjs diagnostics --provider-versions
```

The report lists exactly what it includes and excludes. It includes Cinderdeck/runtime versions, configuration presence and storage presence. `--provider-versions` additionally runs local Codex and Claude `--version` commands, limited to three seconds and 4 KiB each, and exports only version tokens. It excludes credentials, environment values, filesystem paths, database contents, logs, transcripts, recordings and source files. It does not connect to Cinderdeck or claim compatibility. Existing output files are never overwritten; saved reports use owner-only permissions. Review a report before sharing it. Nothing is uploaded automatically.

For service failures, inspect the actual run and named steps in **Services & runs**. For video evidence, deliberately select the recording and prepare its evidence bundle. These are separate content-bearing actions and are not included in a structural diagnostics report.

## Import previous conversations

In **Settings → Storage**, choose the execution computer and copy its previous V2 database from its real absolute path. Administrator access is required for both importing and reading history. Cinderdeck takes a consistent read-only SQLite backup even while the source runtime is running, checks migration versions 55/56, and publishes a separate history archive with a schema report and snapshot fingerprint. It preserves original thread/message IDs and full message text. The source store and current Cinderdeck threads are unchanged.

Read historical conversations in the same panel. Long messages continue through **Read more**. Attachment metadata is retained, but attachment files, credentials, settings, pending tasks and provider runtime are not imported. Provider continuation is unavailable; start new work through the ordinary agent flow. An unsupported schema or interrupted copy produces a report instead of partial usable history. Removing an imported archive retains its report and leaves the source untouched.

The local CLI delegates to the same importer. Use an explicit destination data root and a stable copy key; reusing the key recovers the same copy. Paths must be absolute and contain no symlink components.

```sh
node apps/server/dist/bin.mjs history-import copy --base-dir /absolute/deckhand-data --source /absolute/t3/userdata/statev2.sqlite --operation-key previous-t3-history
node apps/server/dist/bin.mjs history-import list --base-dir /absolute/deckhand-data
node apps/server/dist/bin.mjs history-import threads <import-id> --base-dir /absolute/deckhand-data
node apps/server/dist/bin.mjs history-import messages <import-id> <original-thread-id> --base-dir /absolute/deckhand-data
node apps/server/dist/bin.mjs history-import text <import-id> <original-message-id> --base-dir /absolute/deckhand-data --offset <nextTextOffset>
```

Each archive read is bounded; use the returned continuation offsets. Provider MCP scopes cannot import arbitrary host paths or read these admin-only history archives.

## Move an existing worktree into or out of a Cinderdeck lane

In **Settings → Integrations → Worktree ownership**, choose the execution computer and an existing worktree conversation. Preview adoption into a base workspace, or release an existing lane while keeping its files. The preview lists affected conversations and any running-work blockers. Stop that work first, then confirm the ownership change. Single Git worktrees are supported; multi-repository transitions and projects without a separate worktree are unavailable.

Conversations retain their original IDs and history. Pending or uncertain changes block checkout actions; open the saved receipt to recover the same operation. Disconnecting Cinderdeck never releases a lane. Adoption starts no provider, service or setup task, and release keeps the worktree files. An older Cinderdeck without managed-adoption support must be updated before adoption.

## Debug an application hosted by Excel

Enable **Excel** in **Settings → External apps**, then open **External app → Excel** in a conversation’s right panel to view and control the selected Mac Excel window and its real WebKit Inspector together. Excel retains the workbook APIs and sign-in. See [External app debugging](external-apps.md) for Mac permissions, Inspector setup, and another Mac’s connection.
