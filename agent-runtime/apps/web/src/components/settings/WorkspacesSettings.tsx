import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { workspaceView } from "../../deckhand/state";
import { NativeWorkspaceTools } from "../../deckhand/NativeWorkspaceTools";
import { useAgentObservation } from "../../deckhand/useAgentObservation";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";

export function WorkspacesSettings() {
  const { search } = useSettingsScope();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId = search.machine
    ? environments.find((item) => item.environmentId === search.machine)?.environmentId
    : primary;
  return (
    <SettingsPageContainer>
      <h2 className="text-lg font-semibold">Workspaces</h2>
      <p className="text-sm text-muted-foreground">
        Create a named workspace with folders and individual files from anywhere on your computer.
        Open its settings to add or remove locations without moving the originals.
      </p>
      {environmentId ? (
        <WorkspaceList
          key={environmentId}
          environmentId={environmentId}
          local={environmentId === primary}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect an execution computer to manage its workspaces.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function WorkspaceList({ environmentId, local }: { environmentId: EnvironmentId; local: boolean }) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(workspaceView({ environmentId, input: { offset, limit: 50 } }));
  const view = Option.getOrNull(AsyncResult.value(result));
  const observation = useAgentObservation(environmentId, `settings-workspaces:${offset}`, view);
  const connected = result._tag !== "Failure" && view?.state === "connected" && !observation.stale;
  return (
    <div className="space-y-4">
      {local ? <NativeWorkspaceTools enabled={connected} /> : null}
      <Link
        to="/workspaces"
        search={{ environment: environmentId }}
        className="text-sm text-primary underline"
      >
        Open Workspaces
      </Link>
      {!connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect this computer to manage its workspaces.
        </p>
      ) : null}
      {view?.resources
        .filter((item) => !item.workspace?.lane)
        .map((item) => (
          <section
            key={item.workspaceID}
            className="space-y-2 rounded-lg border p-4"
            aria-label={item.workspace?.name ?? item.workspaceID}
          >
            <h3 className="font-medium">{item.workspace?.name ?? item.workspaceID}</h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {item.workspace?.repos.map((folder) => (
                <li key={folder.id}>Folder: {folder.path}</li>
              ))}
              {item.workspace?.files?.map((file) => (
                <li key={file}>File: {file}</li>
              ))}
            </ul>
            {local ? (
              <NativeWorkspaceTools
                workspaceID={item.workspaceID}
                sourceWorkspaceID={item.workspaceID}
                showSetup={false}
                header
                enabled={connected}
              />
            ) : null}
          </section>
        ))}
      {connected && view?.resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workspaces yet. Add a workspace to choose its folders and files.
        </p>
      ) : null}
      <div className="flex gap-3">
        {offset > 0 ? (
          <button type="button" onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </button>
        ) : null}
        {view?.nextOffset != null ? (
          <button type="button" onClick={() => setOffset(view.nextOffset!)}>
            Next
          </button>
        ) : null}
      </div>
    </div>
  );
}
