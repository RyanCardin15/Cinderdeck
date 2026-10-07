# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Allow the macOS Keychain prompt if one appears. You can leave Chrome and your
other browser windows open; Cinderdeck reads a consistent snapshot of saved cookies.

After a successful import, Cinderdeck remembers the exact source browser and profile for that
environment and destination profile. It refreshes cookies before a new Browser tab loads and when
you reopen an existing tab in the agent side panel. Reopened tabs reload after a successful refresh.
Use **Refresh cookies now** in the Browser panel menu or the profile's Settings menu to refresh
manually. **Stop refreshing from source** keeps the current cookies and disconnects the source.
Clearing cookies or removing a profile also disconnects its source, so opening the panel will not
bring cleared logins back. Existing profiles from older imports need one new import to establish
their source link.

Refresh copies saved cookies in one direction; it does not write back to the source browser or keep
a site session alive indefinitely. Some sites may still require sign-in, and changes not yet saved
by the source browser appear on a later refresh. An unavailable source or denied permission leaves
the existing cookies usable and shows a refresh error. Partial refreshes report skipped cookies.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag Cinderdeck into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen Cinderdeck before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

Partitioned cookies are skipped.
