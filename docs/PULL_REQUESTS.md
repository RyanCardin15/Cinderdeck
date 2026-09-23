# Pull requests

Open the **PRs** icon in History (compact or expanded), press **⌘⇧P**, or choose **Pull requests…** from Cinderdeck's menu bar menu. The resizable window keeps repositories, PR lists, and review details together. Launchers can also open `cinderdeck://prs`.

Change or disable the global shortcut under **Preferences → Shortcuts → Tools → Open pull requests**. The menu item and shortcut list use your configured binding. The app must be running with global shortcuts enabled.

## Connect

Open **Preferences → GitHub** (or the gear beside your account in the PR workspace). The tab shows your verified account and connection status. Choose **Sign in with GitHub**, then **Copy code and open GitHub** to finish authorization in your browser. The tab updates automatically and refreshes the PR workspace after sign-in. You can cancel a pending sign-in, check the connection, or connect another account. Launchers can open `cinderdeck://settings/github`.

Cinderdeck uses the active **github.com** account in [GitHub CLI](https://cli.github.com). If it is missing, Preferences links to its installer. GitHub CLI handles authentication and credential storage; Cinderdeck never reads or stores its token. Signing in also changes the active account for other tools that use GitHub CLI. The flow preserves your configured Git protocol and does not upload SSH keys. An environment-token override is shown as managed by the environment instead of being silently replaced.

One-time codes stay in memory and are cleared on completion, cancellation, or error. Pending sign-in expires after 15 minutes and is cancelled when the app quits. Failed authentication is not automatically retried. The reconnect button in the repository sidebar reloads repositories and picks up external account changes.

The sidebar lists the repositories you own, collaborate on, or can access through an organization. Repository pages load automatically. The star beside a repository adds or removes your **GitHub star**; starred repositories sort first. The star above the repository list switches to starred repositories only. Stars are updated only after GitHub confirms the change.

## Find your work

- **My work** shows PRs you are involved in across GitHub. A role filter such as Review requested replaces that default involvement scope.
- Select a repository to show its PRs from **all authors**. A role filter can narrow that scope.
- **All**, **Active**, **Review requests**, and **Done** provide starting views. Done means merged PRs; use **Closed, unmerged** for PRs closed without merging.
- Filter by state, role, label, or text, and sort by activity, creation date, or discussion count.
- Turn on **Query** for [GitHub search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), such as `is:open author:@me review:required`. Query mode replaces the simple state, label, and text filters. Repository and role scope still apply.
- Results load 50 at a time. **Load more** preserves the current list. GitHub search returns at most 1,000 matches; the app asks you to narrow your filters when you reach that limit.

Use **+** beside the tabs to save the current repository, search, filters, and sorting as a custom view. A dot marks a modified view; **Save changes** updates it. Right-click a custom tab to edit its name, move it, or delete it. Built-in tabs retain the currently selected repository. Custom tabs restore their saved repository. Views and the last filter are saved locally per GitHub account and separately for Debug and Release apps.

## Configure views with agents or scripts

Choose **Agent access** (the sparkles button in the PR window) to connect Codex, Cursor, or Claude Code. The existing Cinderdeck MCP server now exposes `list_pr_views`, `upsert_pr_view`, `select_pr_view`, `reorder_pr_views`, and `delete_pr_view`; existing connections need only reload their tools or restart their client. Agent setup instructions include both stacks and PR views. The CLI is the same `cinderdeck` command installed from Agent access.

Start by listing views. The result includes the active GitHub account, every tab's exact id, filters and generated query, plus the current selection and workspace filters. Supply that account on subsequent changes; Cinderdeck refuses the change if the active GitHub account has switched.

```sh
cinderdeck prs views list
cinderdeck prs views upsert team-reviews --account YOUR_LOGIN \
  --name "Team reviews" --repo my-org/my-repo --role review --select
cinderdeck prs views upsert team-reviews --account YOUR_LOGIN \
  --query 'is:open draft:false review:required' --sort updated
cinderdeck prs views select team-reviews --account YOUR_LOGIN
cinderdeck prs views reorder team-reviews another-custom-id --account YOUR_LOGIN
cinderdeck prs views delete team-reviews --account YOUR_LOGIN
cinderdeck prs --help
```

All CLI results are JSON; errors are JSON on stderr with a nonzero exit code. `--json` is also accepted. Use `--my-work` to clear repository scope, `--text` to return to simple search, and an empty string to clear text or label. Reorder must include every custom id exactly once, including an empty list when there are no custom tabs.

Equivalent MCP creation arguments for `upsert_pr_view`:

```json
{
  "account": "YOUR_LOGIN",
  "id": "team-reviews",
  "name": "Team reviews",
  "filters": {
    "repository": "my-org/my-repo",
    "role": "review",
    "text": "is:open draft:false review:required",
    "advanced": true,
    "sort": "updated"
  },
  "select": true
}
```

`id` is stable (1–100 letters, numbers, hyphens, or underscores): reusing it patches the same tab without creating duplicates. A name of 1–40 characters is required on creation. Omitted fields are preserved on update. New tabs default to My work, open state, anyone, and recently updated. MCP filter tokens are:

| Field | Values |
| --- | --- |
| `repository` | `owner/name`, or `null` for My work |
| `state` | `all`, `open`, `draft`, `merged`, `closed` (unmerged) |
| `role` | `anyone`, `author`, `review`, `assigned`, `involved` |
| `sort` | `updated`, `newest`, `oldest`, `comments` |
| `text`, `label` | Strings; empty clears |
| `advanced` | Boolean; true uses `text` as GitHub search qualifiers |

Query mode retains repository and role scope, including the default involvement scope for My work. `@me` resolves to the active account. Inspect the returned `query` to confirm the effective search. These controls use the same search behavior as the PR window.

Changes persist locally per GitHub account and appear immediately in the open window. Creating a tab does not activate it unless `select` is true. Updating the active saved tab updates its filters when the user has no unsaved edits; otherwise those edits are preserved. Explicit selection replaces unsaved filters. Deleting the active custom tab falls back to Active while retaining repository scope. Built-in tabs can be selected but cannot be edited, deleted, or reordered. Existing saved views require no migration.

The control methods use the existing local socket (`prs.views.list`, `.upsert`, `.select`, `.delete`, `.reorder`) and work even when the PR window is closed. They verify the account through GitHub CLI but do not modify GitHub repositories, stars, or reviews. Debug and Release configurations remain separate.

## Review

Select a row with the mouse or keyboard to open the inspector. It includes description, branches, check summary, labels, review decision, merge conflicts, recent reviews, conversation comments, and changed-file previews. Load additional file pages as needed. Binary or oversized patches may not have a preview; open the complete diff on GitHub in that case. Activity includes the latest 50 reviews and 50 conversation comments, with inline discussions available on GitHub.

**Review…** opens a composer for **Approve**, **Request changes**, or **Comment**. Nothing is posted until you choose **Submit review** or **Submit comment**. Change requests and comments require text. Self-approval, self change requests, closed PRs, and approval of draft PRs are blocked. GitHub enforces repository permissions and review rules.

Before posting, Cinderdeck rechecks the signed-in account and current PR revision. If new commits were pushed, refresh and review them first. Reviews include the exact reviewed commit ID. Failed or uncertain mutations are never automatically retried; check GitHub before resubmitting after an uncertain result. Merging, closing, and inline review threads remain on GitHub.

Press **⌘R** to refresh. The app does not poll GitHub in the background.

## Verification

The focused `PullRequestsTests` suite covers query scopes, saved views and account separation, review validation, revision/account changes before posting, exact review payloads, GraphQL errors, star failure handling, stale responses, and pagination. External writes are tested using injected transports, without posting reviews or changing repository stars.

```sh
scripts/run-tests.sh -only-testing:CinderdeckTests/PullRequestsTests \
  -only-testing:CinderdeckTests/PRViewControlTests -only-testing:CinderdeckTests/StackControlTests
```
