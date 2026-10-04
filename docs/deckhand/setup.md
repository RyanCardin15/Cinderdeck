# Set up Deckhand

Deckhand keeps its data and desktop profile separate from T3. Install the Deckhand build, open it, and choose a computer. For connected work, start Cinderdeck on that execution computer, then choose **Connect to Cinderdeck** during setup or **Settings → Integrations → Cinderdeck**. Inspect the reported installation and workspace before opening it. For a remote computer, this connects to that computer’s Cinderdeck; it does not use the browser viewer’s local app.

Sign in to your selected provider in **Settings → Providers**. Deckhand uses the provider’s existing CLI and authentication flow. Provider credentials stay on the execution host. Choose a configured account and model before starting work. Cinderdeck owns workspace services and lanes; Deckhand owns conversations and feature context.

The default runtime store is `~/.deckhand/userdata`. The macOS desktop profile is `~/Library/Application Support/deckhand-v2`. `DECKHAND_HOME` selects another runtime root; `DECKHAND_PROFILE_ROOT` separately selects the parent of the desktop profile. Setting only one does not isolate the other. Deckhand ignores `T3CODE_HOME` and does not automatically import T3 credentials or databases.

## Troubleshoot a connection

Use **Check connection** to refresh native discovery, installation identity, protocol and capabilities. A changed installation, missing workspace or stale generation requires a deliberate current-workspace selection. Inspect the saved operation using **Check status** after a lost reply; reuse its original operation key. Restarting or creating replacement work is not evidence that the earlier operation failed.

A provider can retain checkout ownership between turns. Use **Stop writer and release** for that specific conversation before running a conflicting native build or review. The transcript and lane remain available. Shared or uncertain ownership is refused until it can be reconciled safely.

## Prepare a local support report

Run `deckhand diagnostics` for an offline structural JSON report. To save it, choose a new filename in an existing directory:

```sh
deckhand diagnostics --base-dir /absolute/deckhand-root --output /absolute/new-report.json
deckhand diagnostics --provider-versions
```

The report lists exactly what it includes and excludes. It includes Deckhand/upstream/runtime versions, configuration presence and storage presence. `--provider-versions` additionally runs local Codex and Claude `--version` commands, limited to three seconds and 4 KiB each, and exports only version tokens. It excludes credentials, environment values, filesystem paths, database contents, logs, transcripts, recordings and source files. It does not connect to Cinderdeck or claim compatibility. Existing output files are never overwritten; saved reports use owner-only permissions. Review a report before sharing it. Nothing is uploaded automatically.

For service failures, inspect the actual run and named steps in **Services & runs**. For video evidence, deliberately select the recording and prepare its evidence bundle. These are separate content-bearing actions and are not included in a structural diagnostics report.

## Import previous T3 conversations

In **Settings → Storage**, choose the execution computer and copy its T3 V2 database from its real absolute path. Administrator access is required for both importing and reading history. Deckhand takes a consistent read-only SQLite backup even while T3 is running, checks migration versions 55/56, and publishes a separate history archive with a schema report and snapshot fingerprint. It preserves original thread/message IDs and full message text. The source T3 store and current Deckhand threads are unchanged.

Read historical conversations in the same panel. Long messages continue through **Read more**. Attachment metadata is retained, but attachment files, credentials, settings, pending tasks and provider runtime are not imported. Provider continuation is unavailable; start new work through the ordinary agent flow. An unsupported schema or interrupted copy produces a report instead of partial usable history. Removing an imported archive retains its report and leaves the source untouched.

The local CLI delegates to the same importer. Use an explicit destination data root and a stable copy key; reusing the key recovers the same copy. Paths must be absolute and contain no symlink components.

```sh
deckhand history-import copy --base-dir /absolute/deckhand-data --source /absolute/t3/userdata/statev2.sqlite --operation-key previous-t3-history
deckhand history-import list --base-dir /absolute/deckhand-data
deckhand history-import threads <import-id> --base-dir /absolute/deckhand-data
deckhand history-import messages <import-id> <original-thread-id> --base-dir /absolute/deckhand-data
deckhand history-import text <import-id> <original-message-id> --base-dir /absolute/deckhand-data --offset <nextTextOffset>
```

Each archive read is bounded; use the returned continuation offsets. Provider MCP scopes cannot import arbitrary host paths or read these admin-only history archives.

## Move an existing worktree between standalone and Cinderdeck

In **Settings → Integrations → Worktree ownership**, choose the execution computer and an existing worktree conversation. Preview adoption into a base workspace, or release an existing lane while keeping its files. The preview lists affected conversations and any running-work or reservation blockers. Stop that work first, then confirm the ownership change. Single Git worktrees are supported; multi-repository transitions and projects without a separate worktree are unavailable.

Conversations retain their original IDs and history. Pending or uncertain changes block checkout actions; open the saved receipt to recover the same operation. Disconnecting Cinderdeck never releases a lane. Adoption starts no provider, service or setup task, and release keeps the worktree files. An older Cinderdeck without managed-adoption support must be updated before adoption.
