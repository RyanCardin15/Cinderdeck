import type { EnvironmentId } from "@cinderdeck/contracts";
import { RefreshButton } from "../components/ui/refresh-button";
import { useAtomCommand } from "../state/use-atom-command";
import { refreshWorkspaces } from "./state";

export function WorkspaceRefreshButton({ environmentId }: { environmentId: EnvironmentId }) {
  const refresh = useAtomCommand(refreshWorkspaces, { reportFailure: false });
  return (
    <RefreshButton
      label="Refresh workspaces"
      successMessage="Workspace status updated"
      onRefresh={async () => {
        const result = await refresh({ environmentId, input: {} });
        if (result._tag !== "Success")
          throw new Error(
            "Could not refresh workspaces. Check this computer’s connection and try again.",
          );
      }}
    />
  );
}
