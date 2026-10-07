# Unified settings

Cinderdeck has one Settings interface in its main application window. Open it with **⌘,**, the application or menu-bar Settings command, a settings link, or a workspace gear. The legacy native preferences window and sidebar are removed. Compatibility callers and `cinderdeck://settings?tab=…` links route into the same settings shell.

## Organization

| Group | Pages |
| --- | --- |
| Personalization | General, Appearance, Keybindings |
| Workspaces & agents | Workspaces, Projects, Providers, Integrations, Source control, Scheduled tasks, External apps |
| Capture & desktop | Capture, Recording, Annotations, Dictation, Quick access, Menu bar, History & clipboard, Cloud uploads, Snap Shot |
| Application | Permissions, Updates, Storage, Connections, Archived, Advanced, About Cinderdeck |

Desktop capabilities appear in the complete Mac app. The sidebar search includes native preference fields and scrolls to their controls without reading native configuration while typing. Device controls show **This Mac**; project and execution-computer controls retain the existing settings scope picker.

## Native controls

Native preferences use the existing storage keys, native managers, configuration validation and Keychain services. The renderer edits a draft and explicitly saves it. A successful native reply confirms the save. A stale edit, failed validation, or missing connection keeps the draft and displays an actionable error. Discard restores the observed values, and navigation warns about unsaved changes.

- **General:** language, save folder, launch at login, sounds, menu icon visibility and Cinderdeck links. Choosing a save folder uses the native chooser and preserves its sandbox access bookmark.
- **Appearance:** appearance of native windows alongside the agent shell’s existing theme and display settings.
- **Keybindings:** native capture, recording, history, quick-access and annotation bindings alongside the shell bindings. Key, modifiers and enabled state save together. Reset desktop shortcuts uses the native default configuration.
- **Capture:** screenshot selection, window shadow, magnifier, hidden desktop elements, image format, file names, post-capture actions, scrolling hints, object cutout and OCR. Custom OCR models have named forms, native connection tests and separate API key controls.
- **Recording:** video format and quality, frame rate, microphone and system audio, file names, post-recording actions, cursor/click/keystroke overlays, annotation modifiers, hover bar, menu timer and editor defaults.
- **Annotations:** tool defaults, clipboard images, crop and text snapping, quick-properties sync and drag behavior.
- **Quick access:** action visibility/order/slots, position, size, dismiss behavior, gestures, sound and animation.
- **Menu bar:** icon style, custom PNG import/removal, item visibility/order and reset.
- **History & clipboard:** capture and clipboard retention, floating panel behavior, storage access and separately confirmed clear actions.
- **Dictation:** macOS speech recognition or a transcription service, on-device recognition, language, endpoint/model/API format/authentication, native Keychain key, hold-to-talk trigger/delay and a sample test. The sample transcript appears inline. Chat dictation still inserts into a draft without sending it.
- **Cloud uploads:** provider configuration, expiration, floating-window position, connection validation, Google authorization, encrypted credential import/export, optional protection password and disconnect. Credentials and protection hashes remain in native Keychain storage. Changing configuration during an asynchronous connection refuses the stale result.
- **Source control:** native GitHub hostname, connection status, device authorization and refresh alongside source-control defaults. Environment-managed credentials retain their existing restrictions.
- **Permissions:** current native screen/microphone/accessibility/save-folder status, OS permission links and notification authorization. OS permission panes are system interfaces opened by an explicit user action.
- **Updates:** whole-app update channel, automatic checks/downloads, live update state, release notes, download/install and restart-to-update. Debug builds use manual release links. Sparkle remains the native update authority.
- **Advanced:** diagnostics, configuration folder access, safe sync/open, export/import and confirmed restoration of native defaults.
- **About Cinderdeck:** installed version/build, support and open-source acknowledgments.

## Workspace settings

Source-workspace gears and **Delete workspace…** open **Settings → Workspaces**. The inline inspector edits the name, folder/file membership, each folder’s independent/shared lane checkout and default starting revision. Code review instructions save separately into `.cinderdeck/skills/code-review/SKILL.md`. An advanced configuration editor covers services, tasks, workflows and lane preparation.

Native writers preserve unrelated definition content. Saves and removals require the observed revision, an exact local source workspace, stopped services/runs and the existing native definition lock and dependency checks. Lane snapshots are not edited as source definitions. Removing a workspace requires the named confirmation action; project folders and files remain on disk. Review instruction saves also reject changes made externally since loading.

Workspace configuration requests, including services/tasks/workflows, also route to this inspector. Project setup, branch selection and the execution map remain native utilities. They do not open another preferences page.

## Implementation and transport

- `agent-runtime/apps/web/src/components/settings/` owns the settings shell, sidebar, scope and existing panels.
- `agent-runtime/apps/web/src/deckhand/NativeSettings.tsx` and `NativeWorkspaceSettings.tsx` render native controls in that shell.
- `UnifiedSettingsNavigation` routes native entry points. `PreferencesWindowController` is a compatibility routing adapter and does not own a window.
- `CinderdeckNativeSettings`, `NativeSettingsUtilities`, `NativeWorkspaceSettings` and `NativeUpdateSettings` keep native preference and lifecycle authority in the parent.
- `DesktopBridge.nativeSettings` is accepted only from the trusted main renderer and uses the private inherited parent pipe. Provider processes, preview frames, remote environments and the public control socket do not receive settings authority.
- UUID-correlated replies, bounded pending work, bounded message sizes, timeouts and shutdown rejection prevent delivery from being mistaken for a completed save. Ordinary settings requests are limited to 16 KiB; workspace editor messages are limited to 128 KiB. Other native UI request decoders retain their 16 KiB bound.
- Forms load only their selected category. Idle pages have no periodic reads. GitHub sign-in, dictation tests and active updates refresh only while active and stop when the page unmounts. Native host identity is cached per desktop bridge.

## Storage and validation

Simple preferences retain `PreferencesKeys` and UserDefaults. Structured preferences retain their existing native stores. Non-secret settings use the configuration exporter/importer described in [CONFIGURATION.md](CONFIGURATION.md). Dictation configuration retains its separate native storage. Secrets are submitted only for explicit credential actions and never returned in snapshots.

Settings validation covers native request bounds, category routing, partial/stale patches, shortcut companion fields, isolated preference persistence, workspace definition preservation, confirmed renderer saves, failed-draft retention, deletion confirmation, pipe correlation and shutdown. Run native tests with `xcodebuild` and runtime tests/typechecks locally. Build the complete application with `scripts/build-unified.sh`; do not treat a web build alone as whole-app validation.

See also [UNIFIED_APP.md](UNIFIED_APP.md), [SHORTCUTS.md](SHORTCUTS.md), [CLOUD.md](CLOUD.md), [POST_CAPTURE.md](POST_CAPTURE.md), and [UPDATES.md](UPDATES.md).

### CLI provider MCP inventory

**Settings → Providers → Copilot CLI / Cursor CLI → MCP servers** lists the configured
servers and their tools using the provider instance's executable and environment. Copilot
supports session-only server and tool switches when conversations start or resume. Cursor
supports inspection and CLI setup guidance; its server and tool permissions are managed in
Cursor's own configuration. See [ACP providers](../agent-runtime/docs/user/providers-acp.md#mcp-servers-and-tools).
