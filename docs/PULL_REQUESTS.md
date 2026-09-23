# Pull requests

Open the **PRs** icon in History (compact or expanded), press **⌘⇧P**, or choose **Pull requests…** from Cinderdeck's menu bar menu. The resizable window keeps repositories, PR lists, and review details together. Launchers can also open `cinderdeck://prs`.

Change or disable the global shortcut under **Preferences → Shortcuts → Tools → Open pull requests**. The menu item and shortcut list use your configured binding. The app must be running with global shortcuts enabled.

## Connect

Open **Preferences → GitHub** (or the gear beside your account in the PR workspace). The tab shows your verified account and connection status. Choose **Sign in with GitHub**, then **Copy code and open GitHub** to finish authorization in your browser. The tab updates automatically and refreshes the PR workspace after sign-in. You can cancel a pending sign-in, check the connection, or connect another account. Launchers can open `cinderdeck://settings/github`.

Cinderdeck uses the active account for the selected host in [GitHub CLI](https://cli.github.com). If it is missing, Preferences links to its installer. GitHub CLI handles authentication and credential storage; Cinderdeck never reads or stores its token. Signing in also changes the active account for other tools that use GitHub CLI. The flow preserves your configured Git protocol and does not upload SSH keys. An environment-token override is shown as managed by the environment instead of being silently replaced.

Organizations on your signed-in account are discovered automatically; no domain entry is needed to switch between them. For an account on a separate GitHub server, expand **Advanced → Use a different GitHub server** in Preferences and choose `github.com`, your enterprise `*.ghe.com` host, or a GitHub Enterprise Server hostname such as `github.company.com`. Enter only the hostname. API requests, sign-in, stars, reviews, and browser links use that host. Saved views are isolated by host and login; changing hosts clears the previous account’s loaded data. GitHub CLI applies the [appropriate environment-token override for that host](https://cli.github.com/manual/gh_help_environment).

One-time codes stay in memory and are cleared on completion, cancellation, or error. Pending sign-in expires after 15 minutes and is cancelled when the app quits. Failed authentication is not automatically retried. The reconnect button in the repository sidebar reloads repositories and picks up external account changes.

The sidebar lists the repositories you own, collaborate on, or can access through an organization. The **Organizations** dropdown includes your organization memberships and organizations discovered through repository access. All memberships appear even before their repositories have loaded. Selecting one clears the repository search and starred-only filter, loads its accessible repositories including additional pages, and scopes PR searches to that organization. Built-in tabs keep this scope; saved views restore their own scope. **All repositories** groups repositories by owner, with your personal repositories first. **My work** returns to your personal inbox across organizations. Organization and repository errors appear separately from PR search errors, with partial repository results retained. Reconnect to refresh discovery. Your GitHub connection must have access to the repositories; organization SSO and token permissions still apply.

Discovery explicitly requests both viewer and owner affiliations from [GitHub’s repository connection](https://docs.github.com/en/graphql/reference/users#user), covering ownership, collaboration, and organization membership. Repository pages load automatically. The star beside a repository adds or removes your **GitHub star**; starred repositories sort first within each owner group. The star above the repository list switches to starred repositories only. Stars are updated only after GitHub confirms the change.

## Find your work

- **My work** shows PRs you are involved in across GitHub. A role filter such as Review requested replaces that default involvement scope.
- Select a repository to show its PRs from **all authors**. A role filter can narrow that scope.
- **All**, **Active**, **Review requests**, and **Done** provide starting views. Done means merged PRs; use **Closed, unmerged** for PRs closed without merging.
- Filter by state, role, label, or text, and sort by activity, creation date, or discussion count.
- Turn on **Query** for [GitHub search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), such as `is:open author:@me review:required`. Query mode replaces the simple state, label, and text filters. Repository and role scope still apply.
- Results load 25 at a time. A search that hits GitHub’s processing timeout retries once with 10 results to reduce the work GitHub must do; authentication failures, rate limits, and local command timeouts are not retried. **Load more** preserves the current list. GitHub search returns at most 1,000 matches; the app asks you to narrow your filters when you reach that limit.

Use **+** beside the tabs to save the current repository, search, filters, and sorting as a custom view. A dot marks a modified view; **Save changes** updates it. Right-click a custom tab to edit its name, move it, or delete it. Built-in tabs retain the currently selected repository. Custom tabs restore their saved repository. Views and the last filter are saved locally per GitHub host and account and separately for Debug and Release apps.

## Review

Select a row with the mouse or keyboard to open the inspector. It includes description, branches, check summary, labels, review decision, merge conflicts, recent reviews, conversation comments, and changed-file previews. Load additional file pages as needed. Binary or oversized patches may not have a preview; open the complete diff on GitHub in that case. Activity includes the latest 50 reviews and 50 conversation comments, with inline discussions available on GitHub.

**Review…** opens a composer for **Approve**, **Request changes**, or **Comment**. Nothing is posted until you choose **Submit review** or **Submit comment**. Change requests and comments require text. Self-approval, self change requests, closed PRs, and approval of draft PRs are blocked. GitHub enforces repository permissions and review rules.

Before posting, Cinderdeck rechecks the signed-in account and current PR revision. If new commits were pushed, refresh and review them first. Reviews include the exact reviewed commit ID. Failed or uncertain mutations are never automatically retried; check GitHub before resubmitting after an uncertain result. Merging, closing, and inline review threads remain on GitHub.

Recent results are cached in memory for one minute. Switching back to a loaded view displays it immediately, including previously loaded pages. Older results stay visible while refreshing; a failed refresh preserves them with their last update time. After the selected view loads, up to eight other built-in/custom views are prefetched, two at a time, with at most three list searches in flight. Selecting an in-flight view shares its request. Speculative loading stops on errors. The session cache is bounded to 16 queries and cleared on reconnect, host/account changes, and successful review submission.

Press **⌘R** to force a refresh. There is no periodic polling. Superseded searches outside the current prefetch set and superseded detail requests are cancelled, including their underlying processes.

## Verification

The focused suites cover warm tabs and saved queries, concurrent request limits and sharing, stale refresh failures, cache invalidation, organization pagination and scope, host/account separation, enterprise API and sign-in routing, timeout fallback, review validation and exact payloads, star failure handling, and process cancellation. External writes are tested using injected transports, without posting reviews or changing repository stars.

```sh
scripts/run-tests.sh -only-testing:CinderdeckTests/PullRequestsTests \
  -only-testing:CinderdeckTests/GitHubAccountTests \
  -only-testing:CinderdeckTests/StackProcessIntegrationTests
```
