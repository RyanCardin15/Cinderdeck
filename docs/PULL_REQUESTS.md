# Pull requests

Open **PRs** from the floating workspace or **Pull requests…** from Cinderdeck's menu bar menu. The resizable window keeps repositories, PR lists, and review details together. Launchers can also open `cinderdeck://prs`.

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

## Review

Select a row with the mouse or keyboard to open the inspector. It includes description, branches, check summary, labels, review decision, merge conflicts, recent reviews, conversation comments, and changed-file previews. Load additional file pages as needed. Binary or oversized patches may not have a preview; open the complete diff on GitHub in that case. Activity includes the latest 50 reviews and 50 conversation comments, with inline discussions available on GitHub.

**Review…** opens a composer for **Approve**, **Request changes**, or **Comment**. Nothing is posted until you choose **Submit review** or **Submit comment**. Change requests and comments require text. Self-approval, self change requests, closed PRs, and approval of draft PRs are blocked. GitHub enforces repository permissions and review rules.

Before posting, Cinderdeck rechecks the signed-in account and current PR revision. If new commits were pushed, refresh and review them first. Reviews include the exact reviewed commit ID. Failed or uncertain mutations are never automatically retried; check GitHub before resubmitting after an uncertain result. Merging, closing, and inline review threads remain on GitHub.

Press **⌘R** to refresh. The app does not poll GitHub in the background.

## Verification

The focused `PullRequestsTests` suite covers query scopes, saved views and account separation, review validation, revision/account changes before posting, exact review payloads, GraphQL errors, star failure handling, stale responses, and pagination. External writes are tested using injected transports, without posting reviews or changing repository stars.

```sh
scripts/run-tests.sh -only-testing:CinderdeckTests/PullRequestsTests
```
