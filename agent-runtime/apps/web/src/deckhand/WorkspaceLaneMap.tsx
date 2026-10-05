import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView, ManagedContextView } from "@t3tools/contracts/deckhand/rpc";
import { buildThreadRouteParams } from "../threadRoutes";
import { agentExecutionLabel, agentProviderLabel } from "./agentPresentation";
import styles from "./workspaceLaneMap.module.css";

type Resource = IntegrationView["resources"][number];
type Providers = ReadonlyArray<{ readonly instanceId: string; readonly displayName: string }>;
type Props = {
  environmentId: EnvironmentId;
  installationID: string;
  resources: ReadonlyArray<Resource>;
  selectedContextID: string;
  onSelectContext: (id: string) => void;
  current: boolean;
  summaries?: ReadonlyArray<ManagedContextView>;
  providers?: Providers;
  cameraKey?: string;
};
type MapNode = {
  id: string;
  kind: "checkout" | "repository" | "service" | "agent";
  contextID: string;
  title: string;
  subtitle: string;
  status: string;
  detail: string;
  shared: boolean;
  available: boolean;
  unresolved?: boolean;
  session?: ManagedContextView["sessions"][number];
  x: number;
  y: number;
};
type Edge = { from: string; to: string; kind: "contains" | "uses" | "fork" };
type Camera = { zoom: number; left: number; top: number };
const EMPTY_SUMMARIES: ReadonlyArray<ManagedContextView> = [];
const EMPTY_PROVIDERS: Providers = [];
const CARD_WIDTH = 224;
const CARD_HEIGHT = 106;
const COLUMN = 270;
const ROW = 124;
const key = (...parts: string[]) => JSON.stringify(parts);
const contextName = (resource: Resource) =>
  resource.workspace?.lane?.name ??
  (resource.workspace ? "Primary checkout" : resource.workspaceID);
const readable = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
function readCamera(storageKey: string): Camera {
  const fallback = { zoom: 0.8, left: 0, top: 0 };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const saved = value as Partial<Camera>;
    return {
      zoom:
        typeof saved.zoom === "number" &&
        Number.isFinite(saved.zoom) &&
        saved.zoom >= 0.25 &&
        saved.zoom <= 1.5
          ? saved.zoom
          : fallback.zoom,
      left:
        typeof saved.left === "number" &&
        Number.isFinite(saved.left) &&
        saved.left >= 0 &&
        saved.left <= 1_000_000
          ? saved.left
          : 0,
      top:
        typeof saved.top === "number" &&
        Number.isFinite(saved.top) &&
        saved.top >= 0 &&
        saved.top <= 1_000_000
          ? saved.top
          : 0,
    };
  } catch {
    return fallback;
  }
}

function graphFor(
  resources: ReadonlyArray<Resource>,
  summaries: ReadonlyArray<ManagedContextView>,
  providers: Providers,
  showAgents: boolean,
) {
  const byContext = new Map(resources.map((resource) => [resource.workspaceID, resource]));
  const primary = resources.find((resource) => resource.workspace && !resource.workspace.lane);
  const nodes = new Map<string, MapNode>();
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  const add = (node: Omit<MapNode, "x" | "y">) => {
    const existing = nodes.get(node.id);
    if (existing) {
      existing.shared ||= node.shared;
      return existing;
    }
    const created = { ...node, x: 0, y: 0 };
    nodes.set(created.id, created);
    return created;
  };
  const connect = (from: string, to: string, kind: Edge["kind"]) => {
    const id = key(from, to, kind);
    if (from !== to && !edgeKeys.has(id)) {
      edgeKeys.add(id);
      edges.push({ from, to, kind });
    }
  };
  const repoIDs = new Map<string, string>();
  const ordered = primary
    ? [primary, ...resources.filter((resource) => resource !== primary)]
    : [...resources];
  for (const resource of ordered) {
    const workspace = resource.workspace;
    const checkout = key("checkout", resource.workspaceID);
    add({
      id: checkout,
      kind: "checkout",
      contextID: resource.workspaceID,
      title: contextName(resource),
      subtitle:
        workspace?.repos.map((repo) => `${repo.id}: ${repo.branch}`).join(" · ") ||
        "Branch unavailable",
      status: resource.available ? (workspace?.state ?? "State unavailable") : "Unavailable",
      detail: [
        workspace?.name,
        workspace?.lane ? "Feature lane" : "Original checkout",
        workspace?.lane?.adopted ? "Adopted checkout" : null,
        workspace?.definitionChanged ? "Definition changed" : null,
        ...(workspace?.issues ?? []),
      ]
        .filter(Boolean)
        .join("\n"),
      shared: false,
      available: resource.available,
    });
    for (const repo of workspace?.repos ?? []) {
      // physicalID identifies one checkout, not all worktrees sharing a Git directory.
      const identity = repo.physicalID
        ? key("physical", repo.physicalID)
        : key("local", resource.workspaceID, repo.id);
      let id = repoIDs.get(identity);
      if (!id) {
        id = key("repository", resource.workspaceID, repo.id);
        repoIDs.set(identity, id);
        add({
          id,
          kind: "repository",
          contextID: resource.workspaceID,
          title: repo.id,
          subtitle: repo.branch,
          status: repo.dirty ? `${repo.changedFiles} changed files` : "Clean",
          detail: `${repo.path}\n${repo.ahead} ahead · ${repo.behind} behind`,
          shared: false,
          available: resource.available,
        });
      }
      const node = nodes.get(id)!;
      node.shared ||= node.contextID !== resource.workspaceID;
      connect(checkout, id, node.contextID === resource.workspaceID ? "contains" : "uses");
      const sourceRepo = primary?.workspace?.repos.find(
        (source) =>
          source.repositoryPhysicalID &&
          source.repositoryPhysicalID === repo.repositoryPhysicalID &&
          source.physicalID &&
          repo.physicalID &&
          source.physicalID !== repo.physicalID,
      );
      if (sourceRepo && primary)
        connect(id, key("repository", primary.workspaceID, sourceRepo.id), "fork");
    }
    for (const service of workspace?.services ?? []) {
      if (service.sharedFrom) continue;
      add({
        id: key("service", resource.workspaceID, service.name),
        kind: "service",
        contextID: resource.workspaceID,
        title: service.name,
        subtitle: service.port ? `Port ${service.port}` : "No port declared",
        status: service.status,
        detail: [service.command, service.cwd, service.url].filter(Boolean).join("\n"),
        shared: false,
        available: resource.available,
      });
    }
    if (showAgents) {
      const summary = summaries.find(
        (item) =>
          item.workspaceID === resource.workspaceID && item.generation === resource.generation,
      );
      for (const session of summary?.sessions.slice(0, 4) ?? []) {
        const id = key("agent", resource.workspaceID, session.binding.id);
        add({
          id,
          kind: "agent",
          contextID: resource.workspaceID,
          title: session.title,
          subtitle: agentProviderLabel(session.binding.providerInstanceId, providers),
          status: session.archived
            ? "Archived"
            : agentExecutionLabel(session.binding.execution, session.source !== "current"),
          detail: `${session.binding.role === "writer" ? "Writer" : session.binding.role === "reviewer" ? "Reviewer" : "Observer"}\n${session.objective ?? "Saved conversation"}`,
          shared: false,
          available: resource.available && session.source === "current",
          session,
        });
        connect(checkout, id, "contains");
      }
    }
  }
  // The bridge includes the owner context, but older snapshots omit a shared
  // alias's target service ID. Preserve that uncertainty rather than guessing.
  const serviceTarget = (
    resource: Resource,
    name: string,
    seen = new Set<string>(),
  ): string | null => {
    const service = resource.workspace?.services.find((item) => item.name === name);
    if (!service) return null;
    if (!service.sharedFrom) return key("service", resource.workspaceID, name);
    const reference = key(resource.workspaceID, name);
    if (seen.has(reference) || seen.size >= 16) return null;
    seen.add(reference);
    const targetServiceID =
      "sharedServiceID" in service && typeof service.sharedServiceID === "string"
        ? service.sharedServiceID
        : null;
    const owner = byContext.get(service.sharedFrom);
    if (targetServiceID && owner) {
      const canonical = serviceTarget(owner, targetServiceID, seen);
      if (canonical) {
        const target = nodes.get(canonical);
        if (target) target.shared = true;
        return canonical;
      }
    }
    const id = key("shared-reference", service.sharedFrom, resource.workspaceID, name);
    add({
      id,
      kind: "service",
      contextID: service.sharedFrom,
      title: name,
      subtitle: `Shared from ${byContext.get(service.sharedFrom) ? contextName(byContext.get(service.sharedFrom)!) : service.sharedFrom}`,
      status: service.status,
      detail: [
        service.url,
        targetServiceID
          ? `Target service: ${targetServiceID}. Its owning service is outside this snapshot.`
          : "The target service name is unavailable in this snapshot.",
        "This reference does not identify a separate owned process.",
      ]
        .filter(Boolean)
        .join("\n"),
      shared: true,
      available: resource.available,
      unresolved: true,
    });
    return id;
  };
  for (const resource of ordered) {
    for (const service of resource.workspace?.services ?? []) {
      const id = serviceTarget(resource, service.name);
      if (!id) continue;
      connect(key("checkout", resource.workspaceID), id, service.sharedFrom ? "uses" : "contains");
      if (!service.sharedFrom)
        for (const dependency of service.dependsOn) {
          const target = serviceTarget(resource, dependency);
          if (target) connect(id, target, "uses");
        }
    }
  }
  const validEdges = edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  const trace = (selection: string, direction: "uses" | "usedBy") => {
    const visited = new Set([selection]);
    const pending = [selection];
    while (pending.length) {
      const id = pending.pop()!;
      for (const edge of validEdges) {
        const next =
          direction === "uses"
            ? edge.from === id
              ? edge.to
              : null
            : edge.to === id
              ? edge.from
              : null;
        if (next && !visited.has(next)) {
          visited.add(next);
          pending.push(next);
        }
      }
    }
    return visited;
  };
  // Keep all direct associations in the inspector, but avoid drawing duplicate
  // checkout-to-service paths already represented by a local dependency.
  const diagramEdges = validEdges.filter(
    (edge) =>
      !(
        nodes.get(edge.from)?.kind === "checkout" &&
        nodes.get(edge.to)?.kind === "service" &&
        validEdges.some(
          (other) =>
            other.from === edge.from &&
            other.to !== edge.to &&
            nodes.get(other.to)?.kind === "service" &&
            nodes.get(other.to)?.contextID === nodes.get(edge.from)?.contextID &&
            trace(other.to, "uses").has(edge.to) &&
            !trace(edge.to, "uses").has(other.to),
        )
      ),
  );
  const bands: Array<{ id: string; title: string; y: number; height: number; shared: boolean }> =
    [];
  let y = 22;
  for (const resource of ordered) {
    const local = [...nodes.values()].filter(
      (node) => node.contextID === resource.workspaceID && !node.shared,
    );
    const counts = [0, 0, 0, 0];
    for (const node of local) {
      const column =
        node.kind === "checkout"
          ? 0
          : node.kind === "repository"
            ? 1
            : node.kind === "service"
              ? 2
              : 3;
      node.x = 22 + column * COLUMN;
      node.y = y + 42 + counts[column]! * ROW;
      counts[column]! += 1;
    }
    const height = Math.max(164, Math.max(...counts) * ROW + 44);
    bands.push({
      id: resource.workspaceID,
      title: contextName(resource),
      y,
      height,
      shared: false,
    });
    y += height + 18;
  }
  const shared = [...nodes.values()].filter((node) => node.shared);
  const columns = showAgents ? 4 : 3;
  shared.forEach((node, index) => {
    node.x = 22 + columns * COLUMN;
    node.y = 64 + index * ROW;
  });
  if (shared.length)
    bands.push({
      id: "shared",
      title: "Shared resources",
      y: 22,
      height: Math.max(y - 40, shared.length * ROW + 44),
      shared: true,
    });
  return {
    nodes: [...nodes.values()],
    edges: validEdges,
    diagramEdges,
    bands,
    trace,
    width: (columns + (shared.length ? 1 : 0)) * COLUMN + 22,
    height: Math.max(y, shared.length * ROW + 90),
    byContext,
  };
}

export function WorkspaceLaneMap(props: Props) {
  const ownerID =
    props.resources.find((resource) => resource.workspace && !resource.workspace.lane)
      ?.workspaceID ??
    props.resources.find((resource) => resource.workspace?.lane)?.workspace?.lane?.sourceStackID ??
    "unavailable";
  const storageKey = key(
    "cinderdeck.lane-map.camera.v1",
    props.environmentId,
    props.installationID,
    props.cameraKey ?? ownerID,
  );
  return <ScopedWorkspaceLaneMap key={storageKey} {...props} storageKey={storageKey} />;
}
function ScopedWorkspaceLaneMap({
  resources,
  selectedContextID,
  onSelectContext,
  current,
  environmentId,
  summaries = EMPTY_SUMMARIES,
  providers = EMPTY_PROVIDERS,
  storageKey,
}: Props & { storageKey: string }) {
  const [initial] = useState(() => readCamera(storageKey));
  const [zoom, setZoom] = useState(initial.zoom);
  const [selection, setSelection] = useState({
    contextID: selectedContextID,
    nodeID: key("checkout", selectedContextID),
  });
  const selectedID =
    selection.contextID === selectedContextID
      ? selection.nodeID
      : key("checkout", selectedContextID);
  const [query, setQuery] = useState("");
  const [showAgents, setShowAgents] = useState(false);
  const [direction, setDirection] = useState<"uses" | "usedBy">("uses");
  const [focus, setFocus] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const camera = useRef(initial);
  const cameraTimer = useRef<number | null>(null);
  const graph = useMemo(
    () => graphFor(resources, summaries, providers, showAgents),
    [resources, summaries, providers, showAgents],
  );
  const selected = graph.nodes.find((node) => node.id === selectedID);
  const traced = selected ? graph.trace(selected.id, direction) : null;
  const visible = focus && traced ? graph.nodes.filter((node) => traced.has(node.id)) : graph.nodes;
  const visibleIDs = new Set(visible.map((node) => node.id));
  const matches = query.trim()
    ? graph.nodes.filter((node) =>
        `${node.title} ${node.subtitle} ${node.detail}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      )
    : [];
  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(camera.current));
    } catch {
      /* Navigation works without storage. */
    }
  }, [storageKey]);
  const save = useCallback(() => {
    camera.current = {
      zoom,
      left: viewport.current?.scrollLeft ?? 0,
      top: viewport.current?.scrollTop ?? 0,
    };
    if (cameraTimer.current !== null) return;
    cameraTimer.current = window.setTimeout(() => {
      cameraTimer.current = null;
      persist();
    }, 150);
  }, [zoom, persist]);
  useEffect(() => {
    if (viewport.current) {
      viewport.current.scrollLeft = initial.left;
      viewport.current.scrollTop = initial.top;
    }
    return () => {
      if (cameraTimer.current !== null) window.clearTimeout(cameraTimer.current);
      persist();
    };
  }, [initial, persist]);
  useEffect(() => {
    save();
  }, [save]);
  const choose = (node: MapNode, jump = false) => {
    setSelection({ contextID: selectedContextID, nodeID: node.id });
    if (node.kind === "checkout") onSelectContext(node.contextID);
    if (jump && viewport.current)
      viewport.current.scrollTo({
        left: Math.max(0, node.x * zoom - 20),
        top: Math.max(0, node.y * zoom - 20),
        behavior: "instant",
      });
  };
  const fit = () => {
    if (!viewport.current) return;
    setZoom(Math.max(0.25, Math.min(1.25, (viewport.current.clientWidth - 20) / graph.width)));
    viewport.current.scrollTo({ left: 0, top: 0 });
  };
  const context = selected ? graph.byContext.get(selected.contextID) : undefined;
  return (
    <section className={styles.map} aria-label="Workspace lane map">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>
            Workspace topology · {current ? "Current snapshot" : "Last observed"}
          </span>
          <h3>Lane map</h3>
        </div>
        <div className={styles.metrics}>
          <span>
            <strong>{resources.length}</strong> checkouts
          </span>
          <span>
            <strong>
              {graph.nodes.filter((node) => node.kind === "service" && !node.unresolved).length}
            </strong>{" "}
            services
          </span>
        </div>
      </header>
      <div className={styles.toolbar}>
        <label className={styles.find}>
          Find in map
          <input
            value={query}
            placeholder="Lane, repository, service or port"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) choose(matches[0], true);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={showAgents}
            onChange={(event) => setShowAgents(event.target.checked)}
          />{" "}
          Agents
        </label>
        <button
          type="button"
          onClick={() => setZoom(Math.max(0.25, zoom - 0.1))}
          aria-label="Zoom out"
          disabled={zoom <= 0.25}
        >
          −
        </button>
        <output aria-label="Map zoom">{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}
          aria-label="Zoom in"
          disabled={zoom >= 1.5}
        >
          ＋
        </button>
        <button type="button" onClick={fit}>
          Fit
        </button>
      </div>
      {query.trim() ? (
        <div className={styles.results} aria-label="Map search results">
          {matches.length ? (
            matches.slice(0, 30).map((node) => (
              <button type="button" key={node.id} onClick={() => choose(node, true)}>
                {node.title}
                <small>
                  {node.kind} ·{" "}
                  {graph.byContext.get(node.contextID)
                    ? contextName(graph.byContext.get(node.contextID)!)
                    : node.contextID}
                </small>
              </button>
            ))
          ) : (
            <p>No matching resources in these checkouts.</p>
          )}
          {matches.length > 30 ? (
            <p>Showing 30 of {matches.length} matches. Refine your search.</p>
          ) : null}
        </div>
      ) : null}
      <div className={styles.checkouts} aria-label="Checkouts">
        {resources.map((resource) => (
          <button
            type="button"
            key={resource.workspaceID}
            aria-pressed={selectedContextID === resource.workspaceID}
            onClick={() => {
              const node = graph.nodes.find(
                (item) => item.id === key("checkout", resource.workspaceID),
              );
              if (node) choose(node, true);
            }}
          >
            {contextName(resource)}
          </button>
        ))}
      </div>
      <div
        ref={viewport}
        className={styles.viewport}
        tabIndex={0}
        aria-label="Lane map canvas"
        onScroll={save}
      >
        <div
          className={styles.surface}
          style={{ width: graph.width * zoom, height: graph.height * zoom }}
        >
          <div
            className={styles.canvas}
            style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}
          >
            {graph.bands.map((band) => (
              <div
                key={band.id}
                className={`${styles.band} ${band.shared ? styles.sharedBand : ""}`}
                style={{
                  left: band.shared ? graph.width - COLUMN : 8,
                  top: band.y,
                  width: band.shared
                    ? COLUMN - 8
                    : graph.width - (graph.bands.some((item) => item.shared) ? COLUMN : 0) - 16,
                  height: band.height,
                }}
              >
                <span>{band.title}</span>
              </div>
            ))}
            <svg
              className={styles.edges}
              width={graph.width}
              height={graph.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={`lm-arrow-${environmentId}`}
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0 0 L6 3 L0 6" />
                </marker>
              </defs>
              {graph.diagramEdges
                .filter((edge) => visibleIDs.has(edge.from) && visibleIDs.has(edge.to))
                .map((edge) => {
                  const from = graph.nodes.find((node) => node.id === edge.from)!;
                  const to = graph.nodes.find((node) => node.id === edge.to)!;
                  const x1 = from.x + CARD_WIDTH,
                    y1 = from.y + CARD_HEIGHT / 2,
                    x2 = to.x,
                    y2 = to.y + CARD_HEIGHT / 2;
                  return (
                    <path
                      key={key(edge.from, edge.to, edge.kind)}
                      className={`${styles.edge} ${edge.kind === "uses" ? styles.uses : edge.kind === "fork" ? styles.fork : ""} ${traced && !(traced.has(edge.from) && traced.has(edge.to)) ? styles.dimmed : ""}`}
                      d={`M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`}
                      markerEnd={`url(#lm-arrow-${environmentId})`}
                    />
                  );
                })}
            </svg>
            {visible.map((node) => (
              <button
                type="button"
                key={node.id}
                className={`${styles.node} ${node.shared ? styles.sharedNode : ""} ${node.kind === "checkout" ? styles.checkout : ""} ${selectedID === node.id ? styles.selected : ""} ${traced && !traced.has(node.id) ? styles.dimmed : ""}`}
                style={{ left: node.x, top: node.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
                aria-pressed={selectedID === node.id}
                onClick={() => choose(node)}
              >
                <span className={styles.kind}>
                  {node.kind}
                  {node.shared ? " · shared" : ""}
                </span>
                <strong>{node.title}</strong>
                <span className={styles.subtitle}>{node.subtitle}</span>
                <span className={styles.status}>
                  {current && node.available ? "" : "Last observed · "}
                  {readable(node.status)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.legend}>
        <span>— Contains</span>
        <span>┄ Uses</span>
        <span>┄ Git worktree relationship</span>
        <span>{visible.length} resources shown</span>
      </div>
      {selected ? (
        <div className={styles.inspector}>
          <div>
            <span className={styles.eyebrow}>
              {selected.kind} · {context ? contextName(context) : selected.contextID}
            </span>
            <h4>{selected.title}</h4>
            <p>
              {current && selected.available ? "" : "Last observed · "}
              {readable(selected.status)}
            </p>
            <p className={styles.detail}>{selected.detail}</p>
            {selected.session ? (
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams({
                  environmentId,
                  threadId: selected.session.binding.threadId,
                })}
              >
                Open conversation →
              </Link>
            ) : context ? (
              <button type="button" onClick={() => onSelectContext(context.workspaceID)}>
                Open {contextName(context)} →
              </button>
            ) : (
              <p>Owning checkout is outside this snapshot.</p>
            )}
          </div>
          <div className={styles.connections}>
            <div className={styles.traceControls}>
              <select
                aria-label="Trace direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as "uses" | "usedBy")}
              >
                <option value="uses">Uses</option>
                <option value="usedBy">Used by</option>
              </select>
              <button type="button" aria-pressed={focus} onClick={() => setFocus(!focus)}>
                Focus
              </button>
              <button
                type="button"
                onClick={() => {
                  setFocus(false);
                  setSelection({ contextID: selectedContextID, nodeID: "" });
                }}
              >
                Clear
              </button>
            </div>
            {graph.edges
              .filter((edge) =>
                direction === "uses" ? edge.from === selected.id : edge.to === selected.id,
              )
              .map((edge) => {
                const node = graph.nodes.find(
                  (item) => item.id === (direction === "uses" ? edge.to : edge.from),
                )!;
                return (
                  <button
                    type="button"
                    key={key(edge.from, edge.to, edge.kind)}
                    onClick={() => choose(node, true)}
                  >
                    <span>
                      {edge.kind === "contains"
                        ? direction === "uses"
                          ? "Contains"
                          : "Contained by"
                        : edge.kind === "fork"
                          ? "Git worktree"
                          : direction === "uses"
                            ? "Uses"
                            : "Used by"}
                    </span>
                    <strong>{node.title}</strong>
                    <small>
                      {graph.byContext.get(node.contextID)
                        ? contextName(graph.byContext.get(node.contextID)!)
                        : node.contextID}
                    </small>
                  </button>
                );
              })}
            {!graph.edges.some((edge) =>
              direction === "uses" ? edge.from === selected.id : edge.to === selected.id,
            ) ? (
              <p>
                No {direction === "uses" ? "outgoing" : "incoming"} relationships in this snapshot.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className={styles.note}>
          Select a checkout to trace what it uses, or a shared service to find its consumers.
        </p>
      )}
      <p className={styles.note}>
        {!current
          ? "Statuses are retained observations. Reconnect before changing this workspace. "
          : ""}
        {showAgents
          ? "Agent overlay shows up to four saved sessions per checkout, not the complete roster. "
          : ""}
        Task, workflow, process-owner and unresolved shared-service target details are not supplied
        by this snapshot. Use Services or the native lane inspector for those details.
      </p>
    </section>
  );
}
