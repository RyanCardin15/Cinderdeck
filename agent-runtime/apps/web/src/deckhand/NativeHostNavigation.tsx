import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NativeHostRoute } from "@cinderdeck/contracts";
import type { WorkspaceSearch } from "./workspaceNavigation";
import { usePrimaryEnvironmentId } from "../state/environments";
import { AGENT_ACCESS_SETTINGS_ID } from "./AgentAccessSettings";
import { nativeSettingsTarget } from "./nativeSettingsNavigation";

/** Native menu/deep-link routes use the local owner, never the viewed remote computer. */
export function NativeHostNavigation() {
  const navigate = useNavigate();
  const environment = usePrimaryEnvironmentId();
  const [pending, setPending] = useState<NativeHostRoute | null>(null);
  useEffect(() => window.desktopBridge?.onNativeHostRoute?.(setPending), []);
  useEffect(() => {
    if (!pending) return;
    if (
      (pending.section === "settings:workspace" ||
        pending.section === "settings:workspace-delete" ||
        pending.section === "settings:workspace-configuration") &&
      pending.workspaceID
    ) {
      setPending(null);
      void navigate({
        to: "/settings/workspaces",
        hash: "native-workspace",
        search: {
          workspace: pending.workspaceID,
          ...(pending.section === "settings:workspace-delete"
            ? { workspaceAction: "delete" }
            : pending.section === "settings:workspace-configuration"
              ? { workspaceAction: "configuration" }
              : {}),
        },
      });
      return;
    }
    const settingsTarget = nativeSettingsTarget(pending.section ?? "");
    if (settingsTarget) {
      setPending(null);
      void navigate({ ...settingsTarget, search: {} });
      return;
    }
    if (!environment) return;
    const target = pending;
    setPending(null);
    const section = (target.section ?? "").toLowerCase();
    // Native Agent access buttons and older shells land on the MCP & skills settings.
    if (section === "agent-access") {
      void navigate({ to: "/settings/integrations", hash: AGENT_ACCESS_SETTINGS_ID });
    } else if (section === "code-review-skill" && target.workspaceID) {
      void navigate({
        to: "/workspaces",
        search: { environment, context: target.workspaceID, tab: "agents", editReviewSkill: true },
      });
    } else if (["services", "tasks", "workflows", "runs", "recordings"].includes(section)) {
      void navigate({
        to: "/workspaces",
        search: {
          environment,
          ...(target.workspaceID ? { context: target.workspaceID } : {}),
          tab: section as NonNullable<WorkspaceSearch["tab"]>,
        },
      });
    } else if (target.section === "pull-requests") {
      void navigate({
        to: "/pull-requests",
        search: { involvement: "all", state: "open", environmentId: environment },
      });
    } else {
      // A lane workspace ID (e.g. after native lane creation) selects that lane; the
      // overview resolves its source workspace from the lane's sourceStackID.
      void navigate({
        to: "/workspaces",
        search: {
          environment,
          ...(target.workspaceID ? { context: target.workspaceID } : {}),
          tab: (target.section ?? "").toLowerCase().includes("agent")
            ? "agents"
            : target.section === "lane-map" || target.section === "overview"
              ? target.section
              : target.workspaceID
                ? "services"
                : "overview",
        },
      });
    }
  }, [environment, navigate, pending]);
  return null;
}
