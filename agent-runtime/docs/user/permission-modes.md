# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

Organization policy can adjust these modes. The picker marks affected modes with
**organization policy** and explains the effective access. Codex checks allowed approval and
sandbox settings; Claude checks whether permission bypass is disabled. Read-only sessions stay
read-only. If a provider rejects a request because of policy, the conversation shows its reason.
Antigravity uses the permission modes advertised by its session and marks adjustments as
**provider policy**. Other providers enforce their own policy settings; policy discovery varies by CLI.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them. If full access is unavailable, it uses an advertised
mode that asks for more approval. Settings shows these restrictions after sign-in or a model
refresh. Configure Antigravity from onboarding or **Settings → Providers**; select the target
environment and choose Google account, Gemini Enterprise, API key, or Agent Platform authentication.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
