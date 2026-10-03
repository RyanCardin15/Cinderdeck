# Working in a Cinderdeck workspace

Open Workspaces and select a primary checkout or an existing lane. To start an agent, choose the repository it should work in, a configured provider account and model, then enter the feature title and objective. Approval-required access is the default. The conversation opens in that repository's existing checkout.

Agent sessions keeps the newest 20 conversations for the selected context. Open one to continue its work or inspect its saved history. A finished turn means the agent has answered; it does not mark the feature complete. Connection state is shown separately, so a saved result can remain available while its provider is stopped.

If a launch reply is lost, use Check result or Retry saved launch. Deckhand keeps that launch request and its conversation identity across a page reload. Change the request only after Deckhand confirms it was refused or failed. Selecting another workspace does not move an existing conversation.

A managed provider retains checkout ownership while its process is resident, including between turns. Native tasks that write that checkout may be refused until the provider stops. If ownership cannot be confirmed after a crash, Deckhand keeps it uncertain; the current preview does not offer automatic takeover or a recovery control.

Native lane lifecycle API clients submit `lane.create`, `lane.adopt`, `lane.setup`, `lane.release` and `lane.remove` through the shared workspace backend and durable operation journal. Each method requires its own advertised native capability. Requests carry the reviewed installation, workspace generation/revision and a stable operation key; use the same key to inspect a lost reply. A resource that changes before dispatch is refused before effects. The API now covers the complete connected lifecycle method set; additional Workspaces controls and standalone lifecycle routing remain in progress.

Setup receipts include the actual setup status and its operation attribution. A succeeded receipt means the native command returned a known result; inspect `result.setup.status` to determine whether setup passed. Release receipts identify the released lane and kept worktrees; removal receipts identify the removed lane and report removed/kept worktrees. Interrupted operations remain uncertain. Setup recovery reads only the state attributed to that operation, and a missing lane record does not establish that an earlier removal succeeded.
