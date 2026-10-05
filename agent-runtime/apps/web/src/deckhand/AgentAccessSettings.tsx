import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  AgentAccessInput,
  AgentAccessInstall,
  AgentAccessStatus,
} from "@cinderdeck/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import {
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../components/settings/settingsLayout";
import { useAtomCommand } from "../state/use-atom-command";
import { agentAccessRequest } from "./agentAccessState";

export const AGENT_ACCESS_SETTINGS_ID = "cinderdeck-agent-access";

const OFFLINE_HELP =
  "Open Cinderdeck on the execution computer, or run cinderdeck setup --all --skills --mod there.";

type Pending = AgentAccessInput["action"] | `${AgentAccessInput["action"]}:${string}` | "status";

function installBadge(install: AgentAccessInstall | undefined, labels: { missing: string }) {
  if (!install) return null;
  switch (install.state) {
    case "current":
      return <Badge variant="success">Up to date</Badge>;
    case "yours":
      return <Badge variant="secondary">Your copy</Badge>;
    case "outdated":
      return <Badge variant="warning">Update available</Badge>;
    case "partial":
      return <Badge variant="warning">Partly installed</Badge>;
    case "missing":
      return <Badge variant="outline">{labels.missing}</Badge>;
  }
}

function installAction(install: AgentAccessInstall) {
  if (install.state === "outdated") return "Update";
  if (install.state === "missing" || install.state === "partial") return "Install";
  return null;
}

/**
 * MCP server registration, bundled skills and the Claude Code mod for the agents on the
 * execution computer. Cinderdeck there does every step; this panel only names agent and action.
 */
export function AgentAccessSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  const command = useAtomCommand(agentAccessRequest, { reportFailure: false });
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [instructions, setInstructions] = useState(true);
  const busy = useRef(false);

  const run = useCallback(
    async (input: AgentAccessInput, key: Pending) => {
      if (!environmentId || busy.current) return;
      busy.current = true;
      setPending(key);
      try {
        const response = await command({ environmentId, input });
        if (response._tag === "Failure") {
          const failure = Option.getOrNull(Cause.findErrorOption(response.cause));
          const unsupported =
            failure !== null && "reason" in failure && failure.reason === "unsupported_capability";
          setProblem(
            unsupported
              ? "Update Cinderdeck on the execution computer to manage MCP and skills here."
              : `Cinderdeck is not reachable. ${OFFLINE_HELP}`,
          );
          return;
        }
        setProblem(null);
        setStatus(response.value.status);
        if (input.action !== "status") {
          toastManager.add({
            type: response.value.ok ? "success" : "error",
            title: response.value.ok ? "Agent access updated" : "Setup did not finish",
            description: response.value.detail,
          });
        }
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [command, environmentId],
  );

  useEffect(() => {
    setStatus(null);
    setProblem(null);
    if (environmentId) void run({ action: "status" }, "status");
  }, [environmentId, run]);

  const disabled = pending !== null || status === null;
  const message = !environmentId
    ? "Connect to an execution computer to set up MCP and skills."
    : (problem ?? undefined);

  return (
    <SettingsSection
      id={AGENT_ACCESS_SETTINGS_ID}
      title="MCP & skills"
      headerAction={
        environmentId ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh MCP and skills status"
            disabled={pending !== null}
            onClick={() => void run({ action: "status" }, "status")}
          >
            <RefreshCwIcon className={pending === "status" ? "animate-spin" : undefined} />
          </Button>
        ) : null
      }
    >
      <SettingsUnavailableGroup message={message}>
        <SettingsRow
          title="Command-line tool"
          description="The cinderdeck command that MCP clients, the Claude Code mod and scripts run."
          status={status?.cli.installed ? <code>{status.cli.path}</code> : undefined}
          control={
            status?.cli.installed ? (
              <Badge variant="success">Installed</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void run({ action: "cli" }, "cli")}
              >
                {pending === "cli" ? "Installing…" : "Install"}
              </Button>
            )
          }
        />
        {(status?.clients ?? []).map((client) => {
          const skillsAction = installAction(client.skills);
          return (
            <SettingsRow
              key={client.id}
              title={client.name}
              description={
                client.mcpConfigured
                  ? `MCP server registered · ${client.skills.detail}`
                  : `MCP via ${client.mcpLocation} · ${client.skills.detail}`
              }
              status={
                <span className="flex flex-wrap items-center gap-1.5">
                  {client.mcpConfigured ? (
                    <Badge variant="success">MCP connected</Badge>
                  ) : (
                    <Badge variant="outline">MCP not set up</Badge>
                  )}
                  {installBadge(client.skills, { missing: "No skills" })}
                </span>
              }
              control={
                <>
                  <Button
                    size="sm"
                    variant={client.mcpConfigured ? "ghost" : "outline"}
                    disabled={disabled}
                    onClick={() =>
                      void run(
                        { action: "mcp", agent: client.id, instructions },
                        `mcp:${client.id}`,
                      )
                    }
                  >
                    {pending === `mcp:${client.id}`
                      ? "Connecting…"
                      : client.mcpConfigured
                        ? "Reconnect"
                        : "Connect MCP"}
                  </Button>
                  {skillsAction ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run({ action: "skills", agent: client.id }, `skills:${client.id}`)
                      }
                    >
                      {pending === `skills:${client.id}` ? "Installing…" : `${skillsAction} skills`}
                    </Button>
                  ) : null}
                </>
              }
            />
          );
        })}
        {status?.claudeMod ? (
          <SettingsRow
            title="Claude Code mod"
            description="A Cinderdeck status line, a /cinderdeck pane to restart services and read logs, and alerts when a service fails."
            status={
              <span className="flex flex-wrap items-center gap-1.5">
                {installBadge(status.claudeMod, { missing: "Not installed" })}
                <span>{status.claudeMod.detail}</span>
              </span>
            }
            control={
              installAction(status.claudeMod) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run({ action: "mod" }, "mod")}
                >
                  {pending === "mod" ? "Installing…" : installAction(status.claudeMod)}
                </Button>
              ) : null
            }
          />
        ) : null}
        <SettingsRow
          title="Usage notes"
          description="When connecting Codex or Claude Code, also add Cinderdeck instructions to ~/.codex/AGENTS.md or ~/.claude/CLAUDE.md."
          control={
            <Switch
              checked={instructions}
              disabled={status === null}
              aria-label="Add Cinderdeck usage notes when connecting MCP"
              onCheckedChange={(checked) => setInstructions(checked)}
            />
          }
        />
        {status && status.skills.length > 0 ? (
          <SettingsRow
            title="Bundled skills"
            description="Installed into each agent's standard skills folder. Copies you manage yourself are never replaced. Restart the agent after changes."
            status={
              <ul className="space-y-1">
                {status.skills.map((skill) => (
                  <li key={skill.name}>
                    <code className="text-foreground">{skill.name}</code> · {skill.summary}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
