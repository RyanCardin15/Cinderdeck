# Moving from Snapzy to Cinderdeck

Cinderdeck is a separate application with bundle identifier `com.ryancardin.cinderdeck` (`.debug` for development). The new executable, Xcode project, scheme, URL scheme, and command are named Cinderdeck / `cinderdeck`.

## Automatic import

The first **Release** launch imports the customized, unsandboxed Snapzy installation:

| Existing source | New destination |
| --- | --- |
| `~/Library/Application Support/Snapzy/snapzy.db` | `~/Library/Application Support/Cinderdeck/cinderdeck.db` |
| Other Snapzy Application Support data | `~/Library/Application Support/Cinderdeck/` |
| `~/.config/snapzy/` | `~/.config/cinderdeck/` |
| Snapzy preferences | Cinderdeck preferences |
| `~/Library/Logs/Snapzy/` | `~/Library/Logs/Cinderdeck/` |

The database uses SQLite’s backup API, including committed WAL records. The import does not move or delete source files and does not overwrite existing Cinderdeck files or preferences. It excludes the old live agent socket and upstream update preferences. Completion is recorded only after a successful import; a failed import stops launch with an error and can be retried. Debug builds do not import production data.

Original capture paths, selected export folders, and custom configuration locations remain valid. The default stack directory and default configuration bookmarks transition to the new location. Files referenced by history stay in their original folders, so **keep the original Snapzy storage until you no longer need those files**. Existing service processes are recognized through their preserved run records; no stack starts merely because the app was renamed.

Very old sandbox-only Snapzy installations should first upgrade to an unsandboxed Snapzy build and complete its existing migration. Cinderdeck’s importer targets the customized unsandboxed build from which it was forked.

## Compatibility

- Existing Keychain service/account identifiers intentionally keep their Snapzy names. Migration never exports or logs credentials. macOS may request permission to access existing credentials from the new application; inaccessible items can be added through Manage secrets.
- Both `cinderdeck://` and legacy `snapzy://` capture shortcuts are accepted.
- `CINDERDECK_AGENT` and `CINDERDECK_AGENT_SESSION` name the CLI/MCP caller. The `SNAPZY_` variables are no longer read. Service environments export both old and new stack/service identity variables.
- Existing managed Git stashes with a `snapzy: before` prefix remain recognized.
- Install the new CLI using `Cinderdeck.app/Contents/MacOS/Cinderdeck services install-cli`. Update MCP clients using `cinderdeck services setup-agents --print` or the Agents & CLI panel. The installer refuses to replace a regular file at the command’s destination.

## macOS permissions

The new identity has its own Screen Recording, Microphone, Camera, and Accessibility grants. Use macOS’s normal permission prompts or System Settings to grant them to Cinderdeck as needed. Signing and TCC state are not copied or bypassed.

## Updates

Cinderdeck cannot install Snapzy’s releases. It has a separate, initially empty appcast and no upstream update key. Until its own signed updates are configured, Check for Updates opens Cinderdeck’s GitHub releases. See [release setup](RELEASES.md).
