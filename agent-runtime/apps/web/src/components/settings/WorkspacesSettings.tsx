import { useId, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderGit2Icon,
  GitBranchIcon,
} from "lucide-react";
import { workspaceView } from "../../deckhand/state";
import { NativeWorkspaceTools } from "../../deckhand/NativeWorkspaceTools";
import { WorkspaceSettingsButton } from "../../deckhand/WorkspaceSettingsButton";
import { useAgentObservation } from "../../deckhand/useAgentObservation";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";

type Resource = IntegrationView["resources"][number];
const pageSize = 20;
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const linkClass =
  "inline-flex shrink-0 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function WorkspacesSettings() {
  const { search } = useSettingsScope();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId = search.machine
    ? environments.find((item) => item.environmentId === search.machine)?.environmentId
    : primary;
  return (
    <SettingsPageContainer>
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Workspaces</h2>
        <p className="max-w-xl text-sm text-muted-foreground">
          Manage your project folders and files. Each workspace keeps its parallel lanes together
          below.
        </p>
      </header>
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
  const result = useAtomValue(
    workspaceView({ environmentId, input: { offset, limit: pageSize, workspacesOnly: true } }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const observation = useAgentObservation(environmentId, `settings-workspaces:${offset}`, view);
  const connected = result._tag !== "Failure" && view?.state === "connected" && !observation.stale;
  const workspaces = view?.resources.filter((item) => item.workspace && !item.workspace.lane) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted-foreground">
          {view ? countLabel(view.total, "workspace") : "Your workspaces"}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link to="/workspaces" search={{ environment: environmentId }} className={linkClass}>
            Open Workspaces <ArrowUpRightIcon className="size-3.5" aria-hidden />
          </Link>
          {local ? (
            <NativeWorkspaceTools environmentId={environmentId} enabled={connected} />
          ) : null}
        </div>
      </div>
      {!connected ? (
        <p
          role="status"
          className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground"
        >
          {AsyncResult.isInitial(result)
            ? "Loading workspaces…"
            : "Reconnect this computer to manage its workspaces. Any workspaces shown are last observed."}
        </p>
      ) : null}
      <div className="space-y-3">
        {workspaces.map((item) => (
          <WorkspaceCard
            key={`${view?.hello?.installationID}:${item.workspaceID}:${item.generation}`}
            resource={item}
            environmentId={environmentId}
            installationID={view?.hello?.installationID}
            connected={connected}
            local={local}
          />
        ))}
      </div>
      {connected && workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <FolderGit2Icon className="mx-auto mb-3 size-7 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            {offset > 0 ? "No workspaces on this page" : "A place for each project"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {offset > 0
              ? "Go back to see your remaining workspaces."
              : "Add a workspace to choose its folders and files. Lanes will appear inside it."}
          </p>
        </div>
      ) : null}
      <PageControls
        offset={offset}
        nextOffset={view?.nextOffset ?? null}
        enabled={connected}
        label="workspaces"
        onChange={setOffset}
      />
    </div>
  );
}

function WorkspaceCard({
  resource,
  environmentId,
  installationID,
  connected,
  local,
}: {
  resource: Resource;
  environmentId: EnvironmentId;
  installationID: string | undefined;
  connected: boolean;
  local: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lanesID = useId();
  const workspace = resource.workspace!;
  const files = workspace.files ?? [];
  const enabled = connected && resource.available;
  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-card"
      aria-label={workspace.name}
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
          <FolderGit2Icon className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="break-words text-sm font-semibold">{workspace.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {countLabel(workspace.repos.length, "folder")}
            {files.length > 0 ? ` · ${countLabel(files.length, "file")}` : ""}
            {!resource.available ? " · Unavailable" : ""}
          </p>
        </div>
        {local ? (
          <WorkspaceSettingsButton
            environmentId={environmentId}
            workspaceID={resource.workspaceID}
            label={`Workspace settings for ${workspace.name}`}
            enabled={enabled}
            showLabel
          />
        ) : (
          <span className="text-xs text-muted-foreground">Edit on this workspace’s Mac</span>
        )}
      </div>
      <details className="group border-t border-border/50">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs text-muted-foreground hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            className="size-3.5 transition-transform group-open:rotate-90"
            aria-hidden
          />
          Folders &amp; files
          <span className="ml-auto">Primary checkout</span>
        </summary>
        <ul className="space-y-3 border-t border-border/40 px-4 py-3">
          {workspace.repos.map((folder) => (
            <li key={folder.id} className="flex items-start gap-2 text-xs">
              <FolderIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="break-all font-mono text-muted-foreground">{folder.path}</p>
                {folder.branch ? (
                  <p className="mt-1 flex items-center gap-1 text-muted-foreground">
                    <GitBranchIcon className="size-3" aria-hidden />
                    {folder.branch}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
          {files.map((file) => (
            <li key={file} className="flex items-start gap-2 text-xs text-muted-foreground">
              <FileIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="break-all font-mono">{file}</span>
            </li>
          ))}
          {workspace.repos.length === 0 && files.length === 0 ? (
            <li className="text-xs text-muted-foreground">No folders or files added yet.</li>
          ) : null}
        </ul>
      </details>
      <div className="border-t border-border/50 bg-muted/15">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={lanesID}
          aria-label={`${expanded ? "Collapse" : "Expand"} lanes for ${workspace.name}`}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-xs font-medium hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRightIcon
            className={`size-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          />
          <GitBranchIcon className="size-3.5 text-muted-foreground" aria-hidden />
          Lanes
          <span className="ml-auto font-normal text-muted-foreground">
            {expanded ? "Hide" : "Show lanes"}
          </span>
        </button>
        <div id={lanesID} hidden={!expanded}>
          {expanded ? (
            <WorkspaceLanes
              environmentId={environmentId}
              resource={resource}
              installationID={installationID}
              connected={enabled}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WorkspaceLanes({
  environmentId,
  resource,
  installationID,
  connected,
}: {
  environmentId: EnvironmentId;
  resource: Resource;
  installationID: string | undefined;
  connected: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(
    workspaceView({
      environmentId,
      input: {
        offset: 0,
        limit: 1,
        selectedWorkspaceID: resource.workspaceID,
        workspacePage: { offset, limit: pageSize },
      },
    }),
  );
  const observed = Option.getOrNull(AsyncResult.value(result));
  const observation = useAgentObservation(
    environmentId,
    `settings-lanes:${resource.workspaceID}:${offset}`,
    observed,
  );
  const view = observed?.hello?.installationID === installationID ? observed : null;
  const page =
    view?.workspaceContexts?.workspaceID === resource.workspaceID ? view.workspaceContexts : null;
  const source = view?.selectedResources?.find((item) => item.workspaceID === resource.workspaceID);
  const fresh =
    connected &&
    source?.generation === resource.generation &&
    result._tag !== "Failure" &&
    view?.state === "connected" &&
    !observation.stale;
  const lanes =
    page?.resources.filter(
      (item) => item.workspace?.lane?.sourceStackID === resource.workspaceID,
    ) ?? [];
  return (
    <div className="space-y-3 border-t border-border/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {page ? countLabel(page.laneCount, "lane") : "Parallel checkouts"} · Settings inherited
          from this workspace
        </p>
        {fresh ? (
          <Link
            to="/workspaces"
            search={{
              environment: environmentId,
              workspace: resource.workspaceID,
              context: resource.workspaceID,
              tab: "lane-map",
              ...(installationID ? { expectedInstallationID: installationID } : {}),
              expectedGeneration: resource.generation,
            }}
            className={linkClass}
          >
            Manage lanes <ArrowUpRightIcon className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      {!fresh ? (
        <p role="status" className="text-xs text-muted-foreground">
          {AsyncResult.isInitial(result)
            ? "Loading lanes…"
            : "Reconnect to refresh lanes. Any lanes shown are last observed."}
        </p>
      ) : null}
      <ul className="ml-1 space-y-1 border-l border-border pl-3">
        {lanes.map((lane) => {
          const name = lane.workspace!.lane!.name;
          const branches = [
            ...new Set(lane.workspace!.repos.map((repo) => repo.branch).filter(Boolean)),
          ];
          return (
            <li key={lane.workspaceID} className="flex items-center gap-3 rounded-md px-2 py-2">
              <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1 text-xs">
                <p className="break-words font-medium">{name}</p>
                <p className="mt-0.5 break-words text-muted-foreground">
                  {branches.join(" · ") || "No branch information"}
                </p>
              </div>
              {fresh && lane.available ? (
                <Link
                  to="/workspaces"
                  aria-label={`Open lane ${name}`}
                  className={linkClass}
                  search={{
                    environment: environmentId,
                    workspace: resource.workspaceID,
                    context: lane.workspaceID,
                    tab: "overview",
                    ...(installationID ? { expectedInstallationID: installationID } : {}),
                    expectedGeneration: lane.generation,
                  }}
                >
                  Open <ArrowUpRightIcon className="size-3" aria-hidden />
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">Unavailable</span>
              )}
            </li>
          );
        })}
      </ul>
      {fresh && page?.laneCount === 0 ? (
        <p className="text-xs text-muted-foreground">
          No lanes yet. Create one from the lane map when you need a parallel checkout.
        </p>
      ) : null}
      <PageControls
        offset={offset}
        nextOffset={page?.nextOffset ?? null}
        enabled={fresh}
        label={`lanes for ${resource.workspace?.name}`}
        onChange={setOffset}
      />
    </div>
  );
}

function PageControls({
  offset,
  nextOffset,
  enabled,
  label,
  onChange,
}: {
  offset: number;
  nextOffset: number | null;
  enabled: boolean;
  label: string;
  onChange: (offset: number) => void;
}) {
  if (offset === 0 && nextOffset === null) return null;
  return (
    <nav aria-label={`${label} pages`} className="flex items-center justify-between gap-3 pt-1">
      <span className="text-xs text-muted-foreground">
        Page {Math.floor(offset / pageSize) + 1}
      </span>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={offset === 0}
          aria-label={`Previous ${label}`}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!enabled || nextOffset === null}
          aria-label={`Next ${label}`}
          onClick={() => {
            if (nextOffset !== null) onChange(nextOffset);
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
