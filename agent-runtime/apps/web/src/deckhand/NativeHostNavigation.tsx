import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NativeHostRoute } from "@cinderdeck/contracts";
import type { WorkspaceSearch } from "./workspaceNavigation";
import { usePrimaryEnvironmentId } from "../state/environments";

/** Native menu/deep-link routes use the local owner, never the viewed remote computer. */
export function NativeHostNavigation() {
  const navigate = useNavigate();
  const environment = usePrimaryEnvironmentId();
  const [pending, setPending] = useState<NativeHostRoute | null>(null);
  useEffect(() => window.desktopBridge?.onNativeHostRoute?.(setPending), []);
  useEffect(() => {
    if (!pending || !environment) return;
    const target = pending;
    setPending(null);
    const section = (target.section ?? "").toLowerCase();
    if (["services", "tasks", "workflows", "runs", "recordings"].includes(section)) {
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
      void navigate({
        to: "/workspaces",
        search: {
          environment,
          ...(target.workspaceID ? { context: target.workspaceID } : {}),
          tab: (target.section ?? "").toLowerCase().includes("agent")
            ? "agents"
            : target.section === "lane-map"
              ? "lane-map"
              : "services",
        },
      });
    }
  }, [environment, navigate, pending]);
  return null;
}
