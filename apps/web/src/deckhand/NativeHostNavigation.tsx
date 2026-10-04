import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NativeHostRoute } from "@t3tools/contracts";
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
    if (["services", "tasks", "workflows", "runs"].includes((target.section ?? "").toLowerCase())) {
      void navigate({ to: "/services", search: { environment, ...(target.workspaceID ? { workspace: target.workspaceID } : {}) } });
    } else if ((target.section ?? "").toLowerCase() === "recordings") {
      void navigate({ to: "/recordings", search: { environment, ...(target.workspaceID ? { workspace: target.workspaceID } : {}) } });
    } else {
      void navigate({ to: "/workspaces", search: { environment,
        ...(target.workspaceID ? { context: target.workspaceID } : {}),
        tab: (target.section ?? "").toLowerCase().includes("agent") ? "agents" : target.section === "lane-map" ? "lane-map" : "overview" } });
    }
  }, [environment, navigate, pending]);
  return null;
}
