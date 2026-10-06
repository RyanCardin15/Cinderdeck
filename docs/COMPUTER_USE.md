# Computer use for agents

Computer use is available through the runtime's conversation-scoped MCP server
on macOS 14 or newer. It operates a chosen Mac app through accessibility and
process-targeted input. Each app requires the person's approval per conversation.
Terminals, Cinderdeck and credential/consent interfaces are excluded. Prefer an
app's dedicated MCP, API or CLI when it covers the task.

## The short path

1. Call `computer_list_apps` for bundle IDs and permission status.
2. Call `computer_get_app_state` with `app` set to an exact bundle ID. This can
   launch the app in the background. The result contains a window list, indexed
   accessibility text and a screenshot image block.
3. Use `computer_set_value` to replace editable values, or `computer_click`,
   `computer_type_text` and `computer_press_key` to interact. Use element indexes
   from the current state. Screenshot coordinates are window-relative image pixels.
4. Read the state again to verify the result. Later reads return changes; pass
   `disableDiff:true` when you need the complete tree. Use `includeScreenshot:false`
   for text checks to avoid screen capture and image payloads.

Select a window with the `window` index from the window list. That selection
persists for the conversation's later reads and actions. Another conversation's
reads cannot change it. Mutations lease the app to one conversation for 90 seconds.
An unchanged window keeps its last screenshot scale across text-only reads.
Read a new screenshot after switching or resizing windows before using coordinates.

## Batch and verify in one call

`computer_script` accepts async JavaScript with top-level await and the same
arguments as the individual tools. Await every call. `write` and `console.log`
produce text, and up to three latest screenshots are returned as images.

```javascript
const app = "com.apple.TextEdit";
const state = await computer.get_app_state({ app, includeScreenshot: false });
write(state.text);
// Locate the intended editable element in the returned text before modifying it.
```

Keep useful values on `globalThis` to retain them across calls; local `const` and
`let` declarations last for one script. `reset:true` discards the conversation's
script globals. Scripts default to a 60-second deadline, with a five-minute
maximum. A timeout resets the worker; already-dispatched app actions may still
finish, so read the app state before retrying. Scripts execute JavaScript in a
Node worker and are a batching facility, not a security sandbox.

Use direct value replacement for large text when the element supports it.
`computer_paste` temporarily changes the clipboard, serializes paste transactions,
waits for the app to read the text, and restores the old content only if nothing
newer has been copied. `computer_activate_app` brings a target forward; use it only
when the app does not accept background input.

## Permissions and recovery

Accessibility is required for app reads and actions; screenshots additionally
require Screen & System Audio Recording. Synthesized input also needs event-posting
access. Check the booleans returned by `computer_list_apps` and follow the specific
error instructions. A missing helper is built with:

```sh
cd agent-runtime
node scripts/deckhand/build-mac-computer-use.mjs
```

`element_missing` or `element_stale` means read fresh state before acting again.
`app_busy` means another conversation currently holds the mutation lease.
`not_settable` means use a supported element action or focus and type.
Native request timeouts terminate the owned helper, removing queued requests;
read fresh state after it restarts. No timeout can undo an action already delivered.

## Development checks

```sh
cd agent-runtime
./node_modules/.bin/vp test run apps/server/src/deckhand/ComputerUse*.test.ts apps/server/src/mcp/toolkits/computerUse/tools.test.ts
node scripts/deckhand/test-mac-computer-use.mjs
# With permission to launch the disposable external fixture app:
node scripts/deckhand/test-mac-computer-use.mjs --external --helper /absolute/path/to/deckhand-mac-computer-use
```

The native test launches only a disposable AppKit fixture with fictional text.
It checks window isolation, stable indexes, direct edits, Unicode selection and
repeated text reads. The optional external mode launches a second synthetic app
and exercises the helper's real background typing, key chords, clicks, screenshots,
modifier clearing and conversation window isolation. All processes and files are
owned by the test; the clipboard is excluded. It requires the helper's macOS
permissions. Clipboard timing, drag/scroll behavior in complex apps, third-party
compatibility and permission identity when launched by the unified app still need
validation in an isolated, approved app/document.
