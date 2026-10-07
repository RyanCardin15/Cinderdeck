import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  AgentAccessInput,
  AgentAccessInstall,
  AgentAccessStatus,
} from "@cinderdeck/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useAtomCommand } from "../state/use-atom-command";
import { agentAccessRequest } from "./agentAccessState";
import styles from "./agentAccessSettings.module.css";

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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (input: AgentAccessInput, key: Pending) => {
      if (!environmentId || busy.current) return;
      busy.current = true;
      setPending(key);
      try {
        const response = await command({ environmentId, input });
        if (!mounted.current) return;
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
        if (mounted.current) setPending(null);
      }
    },
    [command, environmentId],
  );

  useEffect(() => {
    setStatus(null);
    setProblem(null);
    if (environmentId) void run({ action: "status" }, "status");
  }, [environmentId, run]);

  const disabled = pending !== null || status === null || problem !== null || !environmentId;
  const message = !environmentId
    ? "Connect to an execution computer to set up MCP and skills."
    : (problem ?? undefined);

  return (
    <SettingsSection
      id={AGENT_ACCESS_SETTINGS_ID}
      title="MCP & skills"
      variant="plain"
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
      <div className={styles.content}>
        <p className={styles.intro}>
          Let external coding agents use your workspaces, logs and recordings through MCP. Install
          skills to teach them how to use those tools.
        </p>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
        {status && problem ? (
          <p className={styles.intro}>
            Setup shown below was last observed. Refresh to check its current state.
          </p>
        ) : null}
        {environmentId && !status && !problem ? (
          <p className={styles.notice} role="status">
            Checking agent setup…
          </p>
        ) : null}
        {status ? (
          <>
            <div className={styles.group}>
              <SettingsRow
                title="Command-line tool"
                description="Required for MCP connections, scripts and the Claude Code mod."
                status={
                  status.cli.installed ? (
                    <code className={styles.path}>{status.cli.path}</code>
                  ) : (
                    "Install once on this computer."
                  )
                }
                control={
                  status.cli.installed ? (
                    <Badge variant="success">Installed</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => void run({ action: "cli" }, "cli")}
                    >
                      {pending === "cli" ? "Installing…" : "Install CLI"}
                    </Button>
                  )
                }
              />
            </div>
            <div className={styles.clients}>
              {status.clients.map((client) => {
                const skillsAction = installAction(client.skills);
                return (
                  <section
                    key={client.id}
                    className={styles.client}
                    aria-label={`${client.name} setup`}
                  >
                    <h3>{client.name}</h3>
                    <div className={styles.setupRow}>
                      <div>
                        <span className={styles.label}>MCP connection</span>
                        <Badge variant={client.mcpConfigured ? "success" : "outline"}>
                          {client.mcpConfigured ? "MCP connected" : "MCP not set up"}
                        </Badge>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={disabled}
                        aria-label={`${client.mcpConfigured ? "Reconnect" : "Connect MCP for"} ${client.name}`}
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
                    </div>
                    <div className={styles.setupRow}>
                      <div>
                        <span className={styles.label}>Skills</span>
                        {installBadge(client.skills, { missing: "Not installed" })}
                      </div>
                      {skillsAction ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={disabled}
                          aria-label={`${skillsAction} skills for ${client.name}`}
                          onClick={() =>
                            void run({ action: "skills", agent: client.id }, `skills:${client.id}`)
                          }
                        >
                          {pending === `skills:${client.id}`
                            ? "Installing…"
                            : `${skillsAction} skills`}
                        </Button>
                      ) : null}
                    </div>
                    <details className={styles.details}>
                      <summary>
                        <ChevronRightIcon size={13} aria-hidden />
                        Setup details
                      </summary>
                      <p>
                        MCP: <span className={styles.path}>{client.mcpLocation}</span>
                      </p>
                      <p>{client.skills.detail}</p>
                    </details>
                  </section>
                );
              })}
            </div>
            {status.claudeMod ? (
              <div className={styles.group}>
                <SettingsRow
                  title="Claude Code mod"
                  description="Add a status line, service controls, logs and failure alerts inside Claude Code."
                  status={
                    <span className="flex flex-wrap items-center gap-1.5">
                      {installBadge(status.claudeMod, { missing: "Not installed" })}
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
                        {pending === "mod"
                          ? "Installing…"
                          : `${installAction(status.claudeMod)} mod`}
                      </Button>
                    ) : null
                  }
                />
              </div>
            ) : null}
            <details className={styles.options}>
              <summary>
                <ChevronRightIcon size={14} aria-hidden />
                Setup options &amp; included skills
              </summary>
              <SettingsRow
                title="Usage notes"
                description="Add Cinderdeck instructions to Codex’s AGENTS.md or Claude Code’s CLAUDE.md when connecting MCP."
                control={
                  <Switch
                    checked={instructions}
                    disabled={disabled}
                    aria-label="Add Cinderdeck usage notes when connecting MCP"
                    onCheckedChange={setInstructions}
                  />
                }
              />
              <div className={styles.skillList}>
                <p>Restart your agent after setup. Skills you manage yourself are kept.</p>
                <ul>
                  {status.skills.map((skill) => (
                    <li key={skill.name}>
                      <code className={styles.path}>{skill.name}</code>
                      <p>{skill.summary}</p>
                    </li>
                  ))}
                </ul>
                {status.claudeMod ? <p>{status.claudeMod.detail}</p> : null}
              </div>
            </details>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}
