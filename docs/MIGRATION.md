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

Original capture files stay where they were saved, so existing history remains valid. Future exports replace a `Snapzy` folder component with `Cinderdeck` and replace the old product name in screenshot and recording templates. For example, `~/Desktop/Snapzy` becomes `~/Desktop/Cinderdeck`, and `Snapzy_Recording_{datetime}` becomes `Cinderdeck_Recording_{datetime}`. Unrelated custom folders and templates remain unchanged. Old export bookmarks are discarded so they cannot redirect new saves to the old folder.

This repair runs even if the first import already completed. It updates the active TOML export settings before automatic configuration import, preserving comments and unrelated settings. Configuration imports and filename generation also normalize these legacy export settings. The completion marker is now `.legacy-import-completed`.

The default stack directory and default configuration bookmarks transition to the new location. Files referenced by history stay in their original folders, so keep the original storage until you no longer need those files. Existing service processes are recognized through their preserved run records; no stack starts merely because the app was renamed.

Very old sandbox-only Snapzy installations should first upgrade to an unsandboxed Snapzy build and complete its existing migration. Cinderdeck’s importer targets the customized unsandboxed build from which it was forked.

## Compatibility

- New cloud and OCR Keychain entries use `com.ryancardin.cinderdeck` identifiers; workspace secrets use `Cinderdeck Stacks`. Existing credentials are read from previous identifiers and copied into the new identity when used. Migration never exports or logs credentials. macOS may request permission to access existing credentials from the new application; inaccessible items can be added through Manage secrets.
- Both `cinderdeck://` and legacy `snapzy://` capture shortcuts are accepted.
- `CINDERDECK_AGENT` and `CINDERDECK_AGENT_SESSION` name the CLI/MCP caller. New service environments use `CINDERDECK_STACK` and `CINDERDECK_SERVICE`; Cinderdeck no longer generates `SNAPZY_STACK` or `SNAPZY_SERVICE`. Update project scripts that depended on those old generated variables.
- Existing managed Git stashes with a `snapzy: before` prefix remain recognized.
- Install the new CLI using `Cinderdeck.app/Contents/MacOS/Cinderdeck services install-cli`. Update MCP clients using `cinderdeck services setup-agents --print` or the Agents & CLI panel. The installer refuses to replace a regular file at the command’s destination.

## macOS permissions

The new identity has its own Screen Recording, Microphone, Camera, and Accessibility grants. Use macOS’s normal permission prompts or System Settings to grant them to Cinderdeck as needed. Signing and TCC state are not copied or bypassed.

## Updates

Cinderdeck cannot install Snapzy’s releases. It uses its own signed appcast and update key, not Snapzy’s. Copies built from source before signed updates were configured must install a release once; after that Sparkle keeps them current. See [release setup](RELEASES.md).
