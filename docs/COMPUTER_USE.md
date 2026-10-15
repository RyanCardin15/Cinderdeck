# Computer use for agents

Computer use is available through the runtime's conversation-scoped MCP server
on macOS 14 or newer. It operates a chosen Mac app through accessibility and
process-targeted input. Each app requires the person's approval per conversation.
Terminals, Cinderdeck and credential/consent interfaces are excluded. Prefer an
app's dedicated MCP, API or CLI when it covers the task.

The bundled [cinderdeck-computer-use skill](../skills/cinderdeck-computer-use/SKILL.md)
teaches agents how to choose tools, batch actions, keep reads cheap and recover
without replaying uncertain mutations. Install it through **Settings → Integrations
→ MCP & skills**, or `cinderdeck skills install --all`. The skill is guidance;
the conversation must also expose the runtime's `computer_*` tools.

## Attach the app you just used

The conversation composer's **+** menu offers **Add photos & files**, the most
recent external app, and **Take screenshot** with its open-window list. The recent
app row shows its actual macOS icon and window title. Chrome, Safari, Edge, Brave
and Arc can show the active web page title and URL when Accessibility exposes
them; otherwise the row falls back to the app's window title. It never reads a
browser's history or all its tabs.

Selecting a window attaches its screenshot with the app identity, timestamp and
bounded accessibility text when available. The existing attachment shelf lets
you inspect and remove it before sending. Captures require macOS 14 or newer and
Screen Recording permission; Accessibility adds page metadata and text. App
tracking keeps only the latest process identity in memory. Opening the menu does
not capture a screenshot or attach anything. The native host owns capture, and
only the trusted main renderer can request it through the private parent pipe.

Suggestions expire after two minutes. A changed browser tab, closed window or
terminated app requires reopening the menu. Changing conversations discards an
in-flight capture. Native capture remains separate from permission to control an
app: an attachment does not grant an agent computer-use access.

## The short path

1. Call `computer_list_apps` for bundle IDs, running process targets and permission status.
2. Reuse the returned `target` (`pid:<number>`) for an exact running process. Multiple copies of an app can share a bundle ID; ambiguous names/IDs fail with `app_ambiguous`. A process target never launches a replacement. Call `computer_get_app_state` with that target, or a bundle ID when unambiguous. This can
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
Coordinates are checked against the image bounds and an opaque native screenshot
identity. Window moves, resizes, replacement, helper restarts and failed new
captures invalidate the previous mapping. Input to a closed selected window fails
instead of silently reaching another window; a fresh state read can select a new
target. This also distinguishes same-title, same-size windows and app restarts.

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

Chrome native HTML drag-and-drop may ignore background continuation events. If interrupting the foreground fits the authorized task, explicitly activate the selected app, read a fresh screenshot, and call `computer_drag` with `foreground:true`. This mode temporarily moves the system pointer; it verifies the selected foreground window and geometry throughout, stops on user pointer movement, and restores the pointer after completion when unchanged. Background actions never switch to this mode automatically.

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
Screenshot startup waits for the AppKit run loop. Captures are serialized; if ScreenCaptureKit stalls for four seconds or fails, a permission-checked WindowServer capture of the same window takes over. The fallback checks process ownership before and after capture, preserves image coordinate scaling, and ignores late callbacks. A six-second hard capture deadline restarts the owned helper if both capture paths stall, discarding queued requests.

Native request timeouts terminate the owned helper, removing queued requests;
read fresh state after it restarts. No timeout can undo an action already delivered.

## Development checks

Run capture integration checks from Cinderdeck's embedded terminal so the helper stays in the native host's permission responsibility chain. A standalone driver launched outside that chain is not evidence of the app's capture permissions.

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
