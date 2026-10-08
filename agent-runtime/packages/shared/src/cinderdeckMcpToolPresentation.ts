export type CinderdeckMcpToolLogo = "t3-code";

export interface CinderdeckMcpToolPresentation {
  readonly displayName: string;
  readonly logo: CinderdeckMcpToolLogo;
}

export type CinderdeckMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "browser"
  | "device";

export interface CinderdeckMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: CinderdeckMcpToolSummaryAction;
}

function tool(
  labels: CinderdeckMcpToolDefinition["labels"],
  summaryAction: CinderdeckMcpToolSummaryAction,
  icon: CinderdeckMcpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): CinderdeckMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const CINDERDECK_MCP_SERVER_ALIASES = new Set([
  "cinderdeck",
  "cinderdeck-code",
  "cinderdeck_code",
  "t3-code",
  "t3_code",
  "t3code",
  "deckhand",
]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const CINDERDECK_MCP_TOOLS: Readonly<Record<string, CinderdeckMcpToolDefinition>> = {
  deckhand_verification_scenarios: tool(
    ["List", "Listing", "Listed", "verification scenarios"],
    "task-status",
  ),
  deckhand_verification_scenario_save: tool(
    ["Save", "Saving", "Saved", "a verification scenario"],
    "environment-update",
  ),
  deckhand_verification_scenario_remove: tool(
    ["Remove", "Removing", "Removed", "a verification scenario"],
    "environment-update",
  ),
  deckhand_run_detail: tool(["Read", "Reading", "Read", "run details"], "task-status"),
  deckhand_run_failures: tool(["Read", "Reading", "Read", "run failures"], "task-status"),
  deckhand_verification_attempt_preview: tool(
    ["Preview", "Previewing", "Previewed", "a verification attempt"],
    "task-status",
  ),
  deckhand_verification_attempt_start: tool(
    ["Start", "Starting", "Started", "a verification attempt"],
    "task-status",
  ),
  deckhand_verification_attempt_get: tool(
    ["Read", "Reading", "Read", "a verification attempt"],
    "task-status",
  ),
  deckhand_verification_attempt_list: tool(
    ["List", "Listing", "Listed", "verification attempts"],
    "task-status",
  ),
  deckhand_verification_attempt_advance: tool(
    ["Advance", "Advancing", "Advanced", "a verification attempt"],
    "task-status",
  ),
  deckhand_debug_targets: tool(
    ["Find", "Finding", "Found", "external app runtimes"],
    "browser",
    "browser",
  ),
  deckhand_debug_sessions: tool(
    ["List", "Listing", "Listed", "external debug sessions"],
    "browser",
    "browser",
  ),
  deckhand_debug_open: tool(
    ["Open", "Opening", "Opened", "an external Mac app"],
    "browser",
    "browser",
  ),
  deckhand_debug_attach: tool(
    ["Attach", "Attaching", "Attached", "an external debugger"],
    "browser",
    "browser",
  ),
  deckhand_debug_read: tool(
    ["Read", "Reading", "Read", "external app diagnostics"],
    "browser",
    "browser",
  ),
  deckhand_debug_command: tool(
    ["Debug", "Debugging", "Debugged", "an external app"],
    "browser",
    "browser",
  ),
  deckhand_excel_probe: tool(
    ["Inspect", "Inspecting", "Inspected", "add-in telemetry"],
    "browser",
    "browser",
  ),
  deckhand_excel_benchmark: tool(
    ["Benchmark", "Benchmarking", "Benchmarked", "Excel interactions"],
    "browser",
    "browser",
  ),
  deckhand_debug_detach: tool(
    ["Disconnect", "Disconnecting", "Disconnected", "an external debugger"],
    "browser",
    "browser",
  ),
  computer_list_apps: tool(["List", "Listing", "Listed", "Mac apps"], "browser", "device"),
  computer_get_app_state: tool(["Read", "Reading", "Read", "a Mac app"], "browser", "device"),
  computer_click: tool(["Click", "Clicking", "Clicked", "in a Mac app"], "browser", "device"),
  computer_type_text: tool(["Type", "Typing", "Typed", "in a Mac app"], "browser", "device"),
  computer_press_key: tool(
    ["Press", "Pressing", "Pressed", "a key in a Mac app"],
    "browser",
    "device",
  ),
  computer_scroll: tool(["Scroll", "Scrolling", "Scrolled", "a Mac app"], "browser", "device"),
  computer_set_value: tool(["Set", "Setting", "Set", "a value in a Mac app"], "browser", "device"),
  computer_select_text: tool(
    ["Select", "Selecting", "Selected", "text in a Mac app"],
    "browser",
    "device",
  ),
  computer_perform_secondary_action: tool(
    ["Run", "Running", "Ran", "an action in a Mac app"],
    "browser",
    "device",
  ),
  computer_drag: tool(["Drag", "Dragging", "Dragged", "in a Mac app"], "browser", "device"),
  computer_paste: tool(["Paste", "Pasting", "Pasted", "into a Mac app"], "browser", "device"),
  computer_activate_app: tool(
    ["Bring", "Bringing", "Brought", "a Mac app forward"],
    "browser",
    "device",
  ),
  computer_script: tool(["Run", "Running", "Ran", "computer use"], "browser", "device"),
  deckhand_evidence_read: tool(["Read", "Reading", "Read", "evidence bytes"], "attachment-prepare"),
  deckhand_recording_windows: tool(
    ["List", "Listing", "Listed", "capture windows"],
    "attachment-prepare",
  ),
  deckhand_recording_start: tool(
    ["Start", "Starting", "Started", "a recording"],
    "attachment-prepare",
  ),
  deckhand_recording_control: tool(
    ["Control", "Controlling", "Controlled", "a recording"],
    "attachment-prepare",
  ),
  deckhand_recording_mark: tool(["Mark", "Marking", "Marked", "a recording"], "attachment-prepare"),
  deckhand_external_session_register: tool(
    ["Register", "Registering", "Registered", "External session"],
    "worktree-status",
  ),
  deckhand_external_session_heartbeat: tool(
    ["Report", "Reporting", "Reported", "External heartbeat"],
    "worktree-status",
  ),
  deckhand_external_session_visibility: tool(
    ["Save", "Saving", "Saved", "External visibility"],
    "worktree-status",
  ),
  deckhand_external_sessions: tool(
    ["Read", "Reading", "Read", "External sessions"],
    "worktree-status",
  ),
  deckhand_context: tool(["Read", "Reading", "Read", "Cinderdeck lane context"], "worktree-status"),
  deckhand_context_pull_requests: tool(
    ["Read", "Reading", "Read", "lane pull requests"],
    "list-prs",
    "pull-request",
  ),
  deckhand_services_runs: tool(["Read", "Reading", "Read", "services and runs"], "task-status"),
  deckhand_run_logs: tool(["Read", "Reading", "Read", "run output"], "task-status"),
  deckhand_recordings: tool(["List", "Listing", "Listed", "recordings"], "attachment-prepare"),
  deckhand_recording: tool(
    ["Read", "Reading", "Read", "recording provenance"],
    "attachment-prepare",
  ),
  deckhand_recording_logs: tool(
    ["Read", "Reading", "Read", "recording logs"],
    "attachment-prepare",
  ),
  deckhand_evidence_prepare: tool(
    ["Prepare", "Preparing", "Prepared", "evidence bundle"],
    "attachment-prepare",
  ),
  deckhand_evidence_get: tool(
    ["Inspect", "Inspecting", "Inspected", "evidence assets"],
    "attachment-prepare",
  ),
  deckhand_operation_submit: tool(
    ["Submit", "Submitting", "Submitted", "local operation"],
    "task-status",
  ),
  deckhand_operation_get: tool(
    ["Inspect", "Inspecting", "Inspected", "durable operation"],
    "task-status",
  ),

  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  create_threads: tool(["Create", "Creating", "Created", "Cinderdeck threads"], "thread-create"),
  t3_thread_start: tool(["Start", "Starting", "Started", "a Cinderdeck thread"], "thread-create"),
  t3_thread_list: tool(["List", "Listing", "Listed", "Cinderdeck threads"], "thread-list"),
  t3_thread_read: tool(["Read", "Reading", "Read", "a Cinderdeck thread"], "thread-read"),
  t3_thread_send: tool(["Send", "Sending", "Sent", "to a Cinderdeck thread"], "thread-send"),
  t3_thread_wait: tool(["Wait", "Waiting", "Waited", "for a Cinderdeck thread"], "thread-wait"),
  t3_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Cinderdeck thread"],
    "thread-interrupt",
  ),
  t3_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  t3_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  t3_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  t3_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  t3_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  t3_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  t3_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  t3_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  t3_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  t3_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  t3_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  t3_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  t3_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  t3_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  t3_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  t3_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  t3_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  t3_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  t3_thread_update: tool(
    ["Update", "Updating", "Updated", "Cinderdeck thread metadata"],
    "thread-update",
  ),
  t3_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  t3_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  t3_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  t3_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  t3_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  t3_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  t3_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  t3_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  t3_project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  t3_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  t3_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  t3_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  t3_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  t3_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  t3_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
};

/**
 * The Cinderdeck orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const CINDERDECK_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(CINDERDECK_MCP_TOOLS));

function normalizeCinderdeckMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected Cinderdeck server prefixes its tools:
 * `mcp__t3-code__x` (Claude/Cursor), `t3-code.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveCinderdeckMcpToolName(value: string): string | null {
  const label = normalizeCinderdeckMcpToolLabel(value);
  if (Object.hasOwn(CINDERDECK_MCP_TOOLS, label)) return label;
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      CINDERDECK_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>cinderdeck(?:[-_]code)?|t3-code|t3_code|t3code|deckhand)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed =
    /^(?:mcp[-_]{1,2})?(?:cinderdeck(?:[-_ ]code)?|deckhand|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
      label,
    );
  const candidate = prefixed?.groups?.tool ?? label;
  return Object.hasOwn(CINDERDECK_MCP_TOOLS, candidate) ? candidate : null;
}

export function resolveCinderdeckMcpToolDefinition(
  toolName: string | null | undefined,
): CinderdeckMcpToolDefinition | null {
  const name = toolName == null ? null : resolveCinderdeckMcpToolName(toolName);
  return name !== null && Object.hasOwn(CINDERDECK_MCP_TOOLS, name) ? CINDERDECK_MCP_TOOLS[name]! : null;
}

export function resolveCinderdeckMcpToolPresentation(
  toolName: string | null | undefined,
): CinderdeckMcpToolPresentation | null {
  const definition = resolveCinderdeckMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}

export function resolveCinderdeckMcpToolSummaryAction(
  toolName: string | null | undefined,
): CinderdeckMcpToolSummaryAction | null {
  return resolveCinderdeckMcpToolDefinition(toolName)?.summaryAction ?? null;
}
