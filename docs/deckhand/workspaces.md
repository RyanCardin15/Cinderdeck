# Working in a Cinderdeck workspace

Open Workspaces and select a primary checkout or an existing lane. To start an agent, choose the repository it should work in, a configured provider account and model, then enter the feature title and objective. Approval-required access is the default. The conversation opens in that repository's existing checkout.

Agent sessions keeps the newest 20 conversations for the selected context. Open one to continue its work or inspect its saved history. A finished turn means the agent has answered; it does not mark the feature complete. Connection state is shown separately, so a saved result can remain available while its provider is stopped.

If a launch reply is lost, use Check result or Retry saved launch. Deckhand keeps that launch request and its conversation identity across a page reload. Change the request only after Deckhand confirms it was refused or failed. Selecting another workspace does not move an existing conversation.

A managed provider retains checkout ownership while its process is resident, including between turns. Native tasks that write that checkout may be refused until the provider stops. If ownership cannot be confirmed after a crash, Deckhand keeps it uncertain; the current preview does not offer automatic takeover or a recovery control.
