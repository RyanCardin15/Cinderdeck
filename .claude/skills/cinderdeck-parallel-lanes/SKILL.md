---
name: cinderdeck-parallel-lanes
description: Work with ordinary Cinderdeck sessions and optional Git worktrees when independent changes need separate files. The installed skill identifier is retained for compatibility.
---

# Sessions and optional worktrees

Workspaces contain ordinary sessions. Expand a workspace to open its sessions, or press its plus button to start a chat. Sessions can share the same checkout; there are no lane claims or reservations.

Use the existing checkout by default. When independent edits need separate files, select an ordinary Git worktree. For a user-requested new conversation, use `t3_thread_launch` with `workspaceStrategy` (`root`, `worktree`, or `existing_worktree`). For the current conversation, `t3_worktree_handoff` moves it into a new worktree; `adoptExisting: true` plus an absolute path and matching branch selects an existing worktree. This does not create a native lane. Omit the retired `repositoryModes` field.

A handoff detaches the current provider. Pass `continuationPrompt` with the remaining goal, findings and constraints to continue there. Keep the returned path and inspect `t3_worktree_status` before retrying an uncertain move. Never duplicate a handoff simply because its reply was lost.

Services, tasks, workflows, runs and recordings belong to the workspace. Inspect actual ports and URLs with `workspace_details`; optional worktrees do not allocate or isolate service ports automatically. Run checks in the session's actual directory or a configured task/workflow. Preserve uncommitted changes, existing processes, and worktrees used by other sessions. Remove a worktree only with authorization and after checking its contents.

Older checkout records and conversation history remain readable. Legacy lane CLI methods are retained for older scripts and cleanup; do not use them to create new session workspaces. Internal wire identifiers, file paths and storage keys remain compatible.
