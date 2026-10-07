"use client";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cinderdeck/client-runtime/state/runtime";
import {
  EMPTY_PROVIDER_MCP_PREFERENCES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderMcpListResult,
  type ProviderMcpPreferences,
  type ProviderMcpServer,
  type ProviderMcpTool,
} from "@cinderdeck/contracts";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  LockIcon,
  PlugIcon,
  SearchIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describeMcpToolCount,
  filterMcpTools,
  mcpEmptyHint,
  mcpPreferencesKey,
  mcpPreferencesPatchValue,
  mcpSignInHint,
  presentMcpServer,
  setMcpServerEnabled,
  setMcpToolsEnabled,
  type McpStatusTone,
} from "./ProviderMcpSection.logic";
import { SettingsGroup } from "./SettingsGroup";
import { useRelativeTimeTick } from "./settingsLayout";
import { formatRelativeTimeLabel } from "../../timestampFormat";

const TOOL_FILTER_THRESHOLD = 8;

type LoadState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading"; readonly previous: ProviderMcpListResult | null }
  | { readonly phase: "ready"; readonly result: ProviderMcpListResult }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly previous: ProviderMcpListResult | null;
    };

// Listing connects to every server, so keep the last answer for the session
// and only list again on an explicit refresh.
const listCache = new Map<string, ProviderMcpListResult>();

const TONE_DOT: Record<McpStatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/40",
  pending: "bg-muted-foreground/60 motion-safe:animate-pulse",
};

const TONE_TEXT: Record<McpStatusTone, string> = {
  success: "text-muted-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  muted: "text-muted-foreground",
  pending: "text-muted-foreground",
};

/** Renders `code` spans in hint copy written with backticks. */
function InlineCode({ text }: { readonly text: string }) {
  const segments: Array<{
    readonly offset: number;
    readonly text: string;
    readonly code: boolean;
  }> = [];
  let offset = 0;
  for (const [position, part] of text.split("`").entries()) {
    segments.push({ offset, text: part, code: position % 2 === 1 });
    offset += part.length + 1;
  }
  return (
    <>
      {segments.map((segment) =>
        segment.code ? (
          <code
            key={segment.offset}
            className="rounded bg-muted px-1 py-px font-mono text-2xs text-foreground/90"
          >
            {segment.text}
          </code>
        ) : (
          <Fragment key={segment.offset}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function ToolRow({
  tool,
  enabled,
  serverOff,
  providerLabel,
  disabled,
  onToggle,
}: {
  readonly tool: ProviderMcpTool;
  readonly enabled: boolean;
  readonly serverOff: boolean;
  readonly providerLabel: string;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const locked = tool.disabledByProvider === true;
  const description = tool.description ?? null;
  const label = tool.title ?? tool.name;
  return (
    <div
      className={cn(
        "grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1 transition-colors hover:bg-muted/30",
        (!enabled || serverOff || locked) && "opacity-55",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs text-foreground/90">{tool.name}</span>
          {tool.title ? (
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {tool.title}
            </span>
          ) : null}
          {tool.readOnly ? (
            <Badge size="sm" variant="secondary">
              read-only
            </Badge>
          ) : null}
          {tool.destructive ? (
            <Badge size="sm" variant="warning">
              destructive
            </Badge>
          ) : null}
        </div>
        {description ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate text-xs text-muted-foreground" tabIndex={-1}>
                  {description}
                </p>
              }
            />
            <TooltipPopup side="top" className="max-w-sm whitespace-pre-line">
              {description}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {locked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="flex size-6 items-center justify-center text-muted-foreground"
                aria-label={`${tool.name} is off in ${providerLabel} config`}
              />
            }
          >
            <LockIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Off in {providerLabel} config</TooltipPopup>
        </Tooltip>
      ) : (
        <Switch
          size="sm"
          checked={enabled}
          disabled={disabled || serverOff}
          onCheckedChange={onToggle}
          aria-label={`Allow ${label}`}
        />
      )}
    </div>
  );
}

function ServerRow({
  server,
  preferences,
  driver,
  providerLabel,
  readOnly,
  onChange,
}: {
  readonly server: ProviderMcpServer;
  readonly preferences: ProviderMcpPreferences;
  readonly driver: ProviderDriverKind | undefined;
  readonly providerLabel: string;
  readonly readOnly: boolean;
  readonly onChange: (next: ProviderMcpPreferences) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const presentation = presentMcpServer(server, preferences, providerLabel);
  const toolCount = describeMcpToolCount(server, preferences);
  const serverOff = presentation.turnedOff || server.status === "disabled";
  const disabledTools = useMemo(
    () => new Set(preferences.disabledTools[server.name] ?? []),
    [preferences.disabledTools, server.name],
  );
  const toggleableTools = server.tools.filter((tool) => !tool.disabledByProvider);
  const visibleTools = filterMcpTools(server.tools, query);
  const visibleToggleable = visibleTools.filter((tool) => !tool.disabledByProvider);
  const allVisibleOn = visibleToggleable.every((tool) => !disabledTools.has(tool.name));
  const allVisibleOff = visibleToggleable.every((tool) => disabledTools.has(tool.name));
  const name = server.title ?? server.name;
  const hasDetails =
    server.tools.length > 0 || server.error !== undefined || server.status === "needsAuth";

  return (
    <Collapsible open={open && hasDetails} onOpenChange={setOpen} data-mcp-server={server.name}>
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <CollapsibleTrigger
          disabled={!hasDetails}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && hasDetails && "rotate-90",
              !hasDetails && "opacity-0",
            )}
          />
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", TONE_DOT[presentation.tone])}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn(
                  "truncate text-sm",
                  serverOff ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {name}
              </span>
              {server.title ? (
                <span className="truncate font-mono text-xs text-muted-foreground/80">
                  {server.name}
                </span>
              ) : null}
              {server.version ? (
                <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
                  v{server.version}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
              <span className={cn("shrink-0", TONE_TEXT[presentation.tone])}>
                {presentation.label}
              </span>
              {toolCount ? (
                <>
                  <MetaSeparator />
                  <span className="shrink-0 text-muted-foreground tabular-nums">{toolCount}</span>
                </>
              ) : null}
              {server.origin ? (
                <>
                  <MetaSeparator />
                  <span className="truncate text-muted-foreground">{server.origin}</span>
                </>
              ) : null}
            </span>
          </span>
          {server.source ? (
            <Badge size="sm" variant="outline" className="hidden shrink-0 sm:inline-flex">
              {server.source}
            </Badge>
          ) : null}
        </CollapsibleTrigger>
        {presentation.toggleable ? (
          <Switch
            checked={!presentation.turnedOff}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              onChange(setMcpServerEnabled(preferences, server.name, checked))
            }
            aria-label={`Use ${name} in ${providerLabel} sessions`}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
              <Switch checked={false} disabled aria-label={`${name} is off in ${providerLabel}`} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              Turned off in {providerLabel}&apos;s own config. Turn it on there first.
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <CollapsiblePanel>
        <div className="space-y-2.5 border-t border-border/40 bg-muted/10 px-3 py-3 sm:pr-4 sm:pl-11">
          {server.status === "needsAuth" ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/6 px-3 py-2 text-xs text-foreground/85">
              <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <p>
                <InlineCode text={mcpSignInHint(driver, server.name)} />
              </p>
            </div>
          ) : null}
          {server.error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <p className="min-w-0 break-words font-mono text-2xs leading-relaxed text-foreground/80">
                {server.error}
              </p>
            </div>
          ) : null}
          {server.tools.length > 0 ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {server.tools.length > TOOL_FILTER_THRESHOLD ? (
                  <InputGroup className="min-w-40 flex-1">
                    <InputGroupAddon>
                      <SearchIcon aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="search"
                      size="compact"
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder={`Filter ${server.tools.length} tools`}
                      aria-label={`Filter ${name} tools`}
                    />
                  </InputGroup>
                ) : (
                  <span className="flex-1 text-xs text-muted-foreground">Tools</span>
                )}
                {toggleableTools.length > 1 ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={readOnly || serverOff || allVisibleOn}
                      onClick={() =>
                        onChange(
                          setMcpToolsEnabled(
                            preferences,
                            server.name,
                            visibleToggleable.map((tool) => tool.name),
                            true,
                          ),
                        )
                      }
                    >
                      All on
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={readOnly || serverOff || allVisibleOff}
                      onClick={() =>
                        onChange(
                          setMcpToolsEnabled(
                            preferences,
                            server.name,
                            visibleToggleable.map((tool) => tool.name),
                            false,
                          ),
                        )
                      }
                    >
                      All off
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="-mx-2 max-h-80 overflow-y-auto">
                {visibleTools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    enabled={!disabledTools.has(tool.name)}
                    serverOff={serverOff}
                    providerLabel={providerLabel}
                    disabled={readOnly}
                    onToggle={(enabled) =>
                      onChange(setMcpToolsEnabled(preferences, server.name, [tool.name], enabled))
                    }
                  />
                ))}
                {visibleTools.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    No tools match &ldquo;{query.trim()}&rdquo;.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function LoadingRows() {
  return (
    <div aria-busy className="space-y-0">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-3 sm:px-4">
          <Skeleton shape="pill" className="size-2" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className={cn("h-3", index === 1 ? "w-40" : "w-28")} />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton shape="pill" className="h-4 w-7" />
        </div>
      ))}
    </div>
  );
}

function MessageRow({
  icon,
  title,
  children,
  action,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-4 sm:px-4">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm text-foreground/90">{title}</p>
        {children ? <p className="text-xs text-muted-foreground">{children}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ProviderMcpSection({
  environmentId,
  instanceId,
  driver,
  providerLabel,
  providerEnabled,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | undefined;
  readonly providerLabel: string;
  readonly providerEnabled: boolean;
  readonly readOnly?: boolean | undefined;
}) {
  const cacheKey = `${environmentId}:${instanceId}`;
  const listMcpServers = useAtomCommand(serverEnvironment.listProviderMcpServers, {
    reportFailure: false,
  });
  const [state, setState] = useState<LoadState>(() => {
    const cached = listCache.get(cacheKey);
    return cached ? { phase: "ready", result: cached } : { phase: "idle" };
  });
  const requestRef = useRef(0);
  // Keeps the "Checked …" label current.
  useRelativeTimeTick(30_000);

  const storedPreferences = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerMcpPreferences[instanceId],
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const storedKey = mcpPreferencesKey(storedPreferences);
  // Switches answer immediately; the stored value takes over as soon as the
  // server's copy changes (normally the echo of this write).
  const [optimistic, setOptimistic] = useState<{
    readonly basis: string;
    readonly value: ProviderMcpPreferences;
  } | null>(null);
  const preferences =
    optimistic !== null && optimistic.basis === storedKey
      ? optimistic.value
      : (storedPreferences ?? EMPTY_PROVIDER_MCP_PREFERENCES);

  const changePreferences = useCallback(
    (next: ProviderMcpPreferences) => {
      setOptimistic({ basis: storedKey, value: next });
      updateSettings({
        providerMcpPreferences: { [instanceId]: mcpPreferencesPatchValue(next) },
      });
    },
    [instanceId, storedKey, updateSettings],
  );

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setState((current) => ({
      phase: "loading",
      previous:
        current.phase === "ready"
          ? current.result
          : current.phase === "loading" || current.phase === "error"
            ? current.previous
            : null,
    }));
    const result = await listMcpServers({ environmentId, input: { instanceId } });
    if (request !== requestRef.current) return;
    if (result._tag === "Success") {
      listCache.set(cacheKey, result.value);
      setState({ phase: "ready", result: result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setState((current) => ({
      phase: "error",
      message: error instanceof Error ? error.message : "Could not list MCP servers.",
      previous: current.phase === "loading" ? current.previous : null,
    }));
  }, [cacheKey, environmentId, instanceId, listMcpServers]);

  const canList = providerEnabled && !readOnly;
  const startedRef = useRef(false);
  useEffect(() => {
    if (!canList || startedRef.current || listCache.has(cacheKey)) return;
    startedRef.current = true;
    // An idle section already renders as loading, so the first list needs no
    // state change before its answer arrives.
    const request = ++requestRef.current;
    void listMcpServers({ environmentId, input: { instanceId } }).then((result) => {
      if (request !== requestRef.current) return;
      if (result._tag === "Success") {
        listCache.set(cacheKey, result.value);
        setState({ phase: "ready", result: result.value });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Could not list MCP servers.",
          previous: null,
        });
      }
    });
  }, [cacheKey, canList, environmentId, instanceId, listMcpServers]);

  const loading = state.phase === "loading" || (state.phase === "idle" && canList);
  const result =
    state.phase === "ready"
      ? state.result
      : state.phase === "loading" || state.phase === "error"
        ? state.previous
        : null;
  const servers = result?.servers ?? [];
  const enabledServerCount = servers.filter(
    (server) =>
      server.status !== "disabled" &&
      !presentMcpServer(server, preferences, providerLabel).turnedOff,
  ).length;
  const needsAuthCount = servers.filter((server) => server.status === "needsAuth").length;
  const failedCount = servers.filter((server) => server.status === "failed").length;
  const summary =
    servers.length === 0
      ? `Servers and tools ${providerLabel} can use.`
      : [
          `${enabledServerCount} of ${servers.length} ${servers.length === 1 ? "server" : "servers"} on`,
          needsAuthCount > 0 ? `${needsAuthCount} need sign-in` : null,
          failedCount > 0 ? `${failedCount} failed` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const headerAction =
    result?.supported === false ? null : (
      <div className="flex items-center gap-2">
        {result && !loading ? (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Checked {formatRelativeTimeLabel(result.checkedAt)}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!canList || loading}
                aria-busy={loading}
                aria-label="Refresh MCP servers"
                onClick={() => void load()}
              />
            }
          >
            <RefreshIcon refreshing={loading} />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {loading ? "Connecting to MCP servers…" : "Reconnect and list MCP servers"}
          </TooltipPopup>
        </Tooltip>
      </div>
    );

  let body: ReactNode;
  if (!providerEnabled) {
    body = (
      <MessageRow icon={<PlugIcon className="size-3.5" />} title="Provider is off">
        Turn {providerLabel} on to see its MCP servers.
      </MessageRow>
    );
  } else if (result?.supported === false) {
    body = (
      <MessageRow icon={<PlugIcon className="size-3.5" />} title="Not available for this provider">
        {providerLabel} doesn&apos;t report its MCP servers to Cinderdeck. Manage them in its own
        configuration.
      </MessageRow>
    );
  } else if (state.phase === "error" && result === null) {
    body = (
      <MessageRow
        icon={<AlertTriangleIcon className="size-3.5 text-destructive" />}
        title="Couldn't list MCP servers"
        action={
          <Button size="xs" variant="outline" disabled={!canList} onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {state.message}
      </MessageRow>
    );
  } else if (result === null) {
    body = readOnly ? (
      <MessageRow icon={<PlugIcon className="size-3.5" />} title="MCP servers">
        Listing MCP servers needs permission to operate this environment.
      </MessageRow>
    ) : (
      <LoadingRows />
    );
  } else if (servers.length === 0) {
    body = (
      <MessageRow icon={<PlugIcon className="size-3.5" />} title="No MCP servers configured">
        <InlineCode text={mcpEmptyHint(driver)} />
      </MessageRow>
    );
  } else {
    body = (
      <>
        {state.phase === "error" ? (
          <div className="flex items-center gap-2 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground sm:px-4">
            <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate">Refresh failed: {state.message}</span>
          </div>
        ) : null}
        {servers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            preferences={preferences}
            driver={driver}
            providerLabel={providerLabel}
            readOnly={readOnly}
            onChange={changePreferences}
          />
        ))}
      </>
    );
  }

  return (
    <section
      id={`provider-instance-${instanceId}-mcp`}
      aria-label="MCP servers"
      className={cn(
        "space-y-2.5",
        loading && result !== null && "[&_[data-mcp-server]]:opacity-70",
      )}
    >
      <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
        <p className="min-w-0 truncate text-xs text-muted-foreground">{summary}</p>
        {headerAction}
      </div>
      <SettingsGroup>{body}</SettingsGroup>
      {servers.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Changes apply to new {providerLabel} sessions. {providerLabel}&apos;s own config files
          aren&apos;t changed.
        </p>
      ) : null}
    </section>
  );
}
