---
name: cinderdeck-computer-use
description: Operate Mac apps through Cinderdeck's conversation-scoped computer_* MCP tools, using accessibility indexes, cheap state reads and batched JavaScript. Use for native UI tasks that a dedicated API, MCP or CLI does not cover, including verifying background interactions and recovering from stale state.
---

# Use Mac apps with Cinderdeck

Use the `computer_*` tools exposed by the Cinderdeck conversation runtime on macOS 14 or newer. Prefer a dedicated app API, MCP or CLI when it covers the task. This skill does not grant permission to launch apps, change documents or perform external actions beyond the user's request.

If these tools are absent, report that this conversation needs Cinderdeck's computer-use tools; installing the skill alone does not provide them. Do not borrow another conversation's endpoint or credentials. Terminals, Cinderdeck itself and credential/consent interfaces cannot be controlled through these tools.

## Read, act, verify

1. Call `computer_list_apps` once to discover exact bundle IDs and permission status. Reuse the chosen bundle ID rather than repeatedly listing apps.
2. Call `computer_get_app_state({app, includeScreenshot:false})` for tasks identifiable through labels and values. This can launch the app in the background and requests the person's approval for this app in this conversation. Request a screenshot when layout or visual evidence matters.
3. Confirm the intended window from the returned window list. Select it with `window` from that list; the selection persists for subsequent reads and actions. Identify the specific element by its label, role, value and surrounding context. Never invent an index or use the first text field without establishing its purpose.
4. Choose the cheapest supported action below. Act on indexes from this conversation's latest state of that app/window.
5. Read state to verify the intended change before continuing. A successful action response means dispatch succeeded; it does not prove that a document saved, a message sent or an export completed.

Later reads are diffs: `+` adds, `~` changes and `-` removes an element. Unchanged elements keep their indexes. Apply the diff to your known state; an omitted element is not necessarily gone. Request `disableDiff:true` when you have lost the prior state or need the complete tree, rather than on every read.

## Choose an action

| Need | Preferred tool | Important detail |
| --- | --- | --- |
| Replace an editable value | `computer_set_value({app, element_index, value})` | Direct accessibility edit; prefer this for large text when supported. |
| Press a control | `computer_click({app, element_index})` | Uses the accessibility action when available. |
| Enter text through keyboard behavior | `computer_type_text({app, element_index, text})` | Focuses the specified element first; newlines press Return. |
| Select text or position the caret | `computer_select_text({app, element_index, text, selection_type})` | `text`, `cursor_before`, or `cursor_after`; use `prefix`/`suffix` for repeated matches. |
| Use a shortcut | `computer_press_key({app, key})` | Examples: `super+s` for Command-S, `Return`, `Tab`, `Escape`. Verify the effect. |
| Invoke a listed element action | `computer_perform_secondary_action({app, element_index, action})` | Use an exact Secondary Actions label from state. |
| Reveal offscreen content | `computer_scroll({app, element_index, direction, pages:1})` | Read again after scrolling to discover the new content. |
| Paste long text when direct editing is unavailable | `computer_paste({app, text})` | Establish the intended focus first. Temporarily uses the clipboard and restores it unless newer content was copied. |
| Click or drag without a usable accessibility element | `computer_click({app, x, y})` / `computer_drag({app, from_x, from_y, to_x, to_y})` | Use a current screenshot's window-relative image pixels, not desktop coordinates or normalized values. |

Get a fresh screenshot before coordinate actions after switching or resizing a window, or any layout change. Text-only reads preserve the last screenshot's scale for unchanged geometry; they do not supply fresh visual evidence. Prefer element actions when possible.

Actions normally run in the background with an agent cursor. Use `computer_activate_app` only when the app demonstrably ignores background input and bringing it forward fits the user's request; it interrupts their foreground work.

## Keep calls and payloads small

Use `includeScreenshot:false` for value checks and polling. Capture images at visual decision points and for final visual evidence, not after every keystroke. Keep diffs enabled. Batch a short, understood sequence with `computer_script` to reduce tool round trips, then verify it; pause to inspect any new dialog or unknown layout before choosing further actions.

Scripts accept `{code, timeout_ms?, reset?}` and provide top-level `await`, `computer`, `write` and `sleep`. Methods use the same arguments as the matching tools without the `computer_` prefix. Await every call and serialize actions on the same app; `Promise.all` does not make dependent UI actions reliable. Print only the relevant state or finding. Screenshots arrive as image blocks; do not print encoded images.

For example, after inspecting state and storing the observed bundle ID and field index on `globalThis.targetApp` and `globalThis.targetField`, batch an authorized field edit and its readback:

```javascript
const app = globalThis.targetApp;
const element_index = globalThis.targetField;
if (typeof app !== "string" || !Number.isInteger(element_index)) {
  throw new Error("Inspect the target window and record the intended field first.");
}
await computer.set_value({ app, element_index, value: "Draft title" });
const after = await computer.get_app_state({ app, includeScreenshot: false });
write(after.text); // Inspect the field's returned value before proceeding.
```

Use the user's intended value in actual work. `const`/`let` last only for that script; `globalThis` values can persist between scripts in this conversation. They may be lost after idle cleanup, reset or timeout, so reconstruct missing state from a new read. Persistent indexes still need current app/window context. `reset:true` clears globals.

The default script deadline is 60 seconds; the maximum is five minutes. Prefer a short bounded poll for an expected asynchronous change, with text-only reads and a brief `sleep`, over a large blind delay or an unbounded loop. Check for the specific expected value, window or completion state. Stop when the deadline expires and report the unresolved condition.

## Recover using the failure reason

- `element_missing`, `element_stale`, `window_missing`: read fresh state, confirm the window and reacquire the intended element; use a full tree if context is missing.
- `not_settable`, `unsupported_action`: choose a supported listed action, or focus the intended field and type. Read before changing strategy after a possibly partial operation.
- `text_not_found`: inspect the actual field value and disambiguate the match rather than guessing a selection.
- `app_busy`: another conversation holds this app's mutation lease. Wait briefly or do independent work; do not steal focus or repeat mutations rapidly.
- `timeout`, failed script, or interrupted call: earlier actions may already have completed. Read current state before retrying, particularly before an append, submit, save or export. Never replay the entire batch blindly.
- Permission, locked-screen or denied-approval errors: follow the returned instructions and let the person resolve the permission or unlock. Do not automate security UI or retry a denial.
- `app_missing` or `native_unavailable`: check the target/tool environment once and report what is missing rather than issuing repeated action calls.

Finish with the observed result and any remaining uncertainty. Use fresh screenshots for visual claims and the app's actual completion state for save/export/submit claims. Complex drag/scroll and third-party background input vary by app; successful dispatch alone is insufficient evidence.
