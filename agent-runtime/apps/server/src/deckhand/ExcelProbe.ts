// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Loopback ingestion for the development-only add-in probe. Transient, bounded state.
import * as NodeHttp from "node:http";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  EXCEL_PROBE_EVENTS_PATH,
  EXCEL_PROBE_HEADER,
  EXCEL_PROBE_SCRIPT_PATH,
  type Distribution,
  type NamedDistribution,
  type ProbeClient,
  type ProbeEvent,
  type ProbeEventKind,
  type ProbeStatus,
  type ProbeSummary,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import { array, debugURL, number, record, redactDebugText, string } from "./ExternalDebugCDP.ts";
import { EXCEL_PROBE_SCRIPT } from "./ExcelProbeScript.ts";

const fail = (reason: C.ExternalDebugError["reason"]) => new C.ExternalDebugError({ reason });
const CONNECTED_MS = 10_000;
const MAX_EVENTS = 20_000;
const MAX_BODY = 512_000;

export function distribution(values: ReadonlyArray<number>): Distribution {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return { count: 0, total: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  // Nearest-rank percentiles: always an observed value, stable for small samples.
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    total: round(total),
    min: round(sorted[0]!),
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
    max: round(sorted.at(-1)!),
    mean: round(total / sorted.length),
  };
}
export function namedDistributions(
  entries: ReadonlyArray<{ name: string; value: number }>,
  limit: number,
): NamedDistribution[] {
  const groups = new Map<string, number[]>();
  for (const entry of entries) {
    const group = groups.get(entry.name);
    if (group) group.push(entry.value);
    else if (groups.size < limit) groups.set(entry.name, [entry.value]);
  }
  return [...groups].map(([name, values]) => ({ name, ...distribution(values) }));
}
export const duration = (event: ProbeEvent) =>
  Math.max(0, (event.end ?? event.start) - event.start);
export const isRequest = (event: ProbeEvent) => event.kind === "fetch" || event.kind === "xhr";
export const isFailure = (event: ProbeEvent) =>
  event.kind === "error" || (event.kind === "console" && event.level === "error");

function summarize(events: ReadonlyArray<ProbeEvent>): ProbeSummary {
  const of = (kind: ProbeEventKind) => events.filter((event) => event.kind === kind);
  const requests = events.filter(isRequest);
  const resources = of("resource");
  return {
    runs: distribution(of("run").map(duration)),
    syncs: distribution(of("sync").map(duration)),
    syncFailures: of("sync").filter((event) => event.ok === false).length,
    requests: distribution(requests.map(duration)),
    requestFailures: requests.filter((event) => event.ok === false).length,
    resources: distribution(resources.map(duration)),
    transferBytes: resources.reduce((sum, event) => sum + (event.bytes ?? 0), 0),
    errors: events.filter(isFailure).length,
    warnings: events.filter((event) => event.kind === "console" && event.level === "warning")
      .length,
    jank: distribution(of("jank").map(duration)),
    measures: namedDistributions(
      of("measure").map((event) => ({ name: event.name ?? "", value: duration(event) })),
      100,
    ),
  };
}

const kinds = new Set<string>([
  "probe",
  "ready",
  "run",
  "sync",
  "fetch",
  "xhr",
  "resource",
  "navigation",
  "paint",
  "mark",
  "measure",
  "console",
  "error",
  "jank",
]);
type Raw = { -readonly [K in keyof Omit<ProbeEvent, "sequence">]: ProbeEvent[K] };
// Validates one page-reported event. Times must be plausible epoch milliseconds; URLs lose
// credentials, queries and fragments; text is redacted like other external diagnostics.
function normalizeProbeEvent(client: string, raw: unknown, received: number): Raw | null {
  const value = record(raw);
  const kind = string(value.k);
  if (!kinds.has(kind)) return null;
  const start = number(value.t0) || number(value.t);
  if (Math.abs(start - received) > 24 * 60 * 60_000) return null;
  const end = number(value.t1);
  const event: Raw = { client, kind: kind as ProbeEventKind, start };
  if (end >= start && end - start < 60 * 60_000) event.end = end;
  const name = string(value.n);
  if (name)
    event.name = isUrlKind(kind) ? debugURL(name) || name.slice(0, 32) : redactDebugText(name, 500);
  const detail = string(value.x);
  if (detail) event.detail = redactDebugText(detail, 2000);
  if (Number.isInteger(value.s)) event.status = Math.max(-1, Math.min(999, number(value.s)));
  const bytes = number(value.b);
  if (bytes > 0) event.bytes = Math.min(Math.round(bytes), 2 ** 40);
  const count = number(value.c);
  if (count > 0) event.count = Math.min(Math.round(count), 1_000_000);
  if (typeof value.ok === "boolean") event.ok = value.ok;
  if (kind === "console") {
    const level = string(value.l);
    event.level = level === "error" ? "error" : level === "warn" ? "warning" : "info";
  } else if (kind === "error") event.level = "error";
  return event;
}
const isUrlKind = (kind: string) =>
  kind === "fetch" || kind === "xhr" || kind === "resource" || kind === "navigation";

type Client = ProbeClient & { touched: number };
type Collector = {
  actor: string;
  events: ProbeEvent[];
  sequence: number;
  dropped: number;
  touched: number;
};

export class ProbeHub {
  private server: NodeHttp.Server | null = null;
  private starting: Promise<void> | null = null;
  private unavailable: string | null = null;
  private readonly clients = new Map<string, Client>();
  private readonly collectors = new Map<string, Collector>();
  private readonly port: number;
  constructor(port: number) {
    this.port = port;
  }
  get listeningPort() {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : this.port;
  }
  // Starts on first use so idle servers and tests never hold the port.
  ensureListening(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = NodeHttp.createServer((request, response) => this.handle(request, response));
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.once("error", (cause: NodeJS.ErrnoException) => {
        this.starting = null;
        this.unavailable =
          cause.code === "EADDRINUSE"
            ? `Port ${this.port} is in use by another process or Cinderdeck instance. Set CINDERDECK_EXCEL_PROBE_PORT for both Cinderdeck and the add-in dev server.`
            : "The probe listener could not start.";
        reject(fail("busy"));
      });
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        this.unavailable = null;
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }
  close() {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.starting = null;
    this.collectors.clear();
    this.clients.clear();
  }
  arm(actor: string) {
    const existing = this.collectors.get(actor);
    if (existing) existing.touched = Date.now();
    else
      this.collectors.set(actor, {
        actor,
        events: [],
        sequence: 0,
        dropped: 0,
        touched: Date.now(),
      });
  }
  disarm(actor: string) {
    this.collectors.delete(actor);
  }
  reset(actor: string) {
    const collector = this.collectors.get(actor);
    if (collector) {
      collector.events = [];
      collector.dropped = 0;
    }
  }
  isArmed(actor: string) {
    return this.collectors.has(actor);
  }
  expire(idleMs: number) {
    for (const [actor, collector] of this.collectors)
      if (Date.now() - collector.touched > idleMs) this.collectors.delete(actor);
  }
  connectedClients(): ProbeClient[] {
    const cutoff = Date.now() - CONNECTED_MS;
    return [...this.clients.values()]
      .toSorted((a, b) => b.lastSeen - a.lastSeen)
      .map(({ touched: _touched, ...client }) => ({
        ...client,
        connected: client.lastSeen >= cutoff,
      }));
  }
  // Outstanding Office syncs and requests across connected pages, and the oldest
  // heartbeat, so a caller knows every event up to that time has been delivered.
  activity() {
    const clients = this.connectedClients().filter((client) => client.connected);
    return {
      clients: clients.length,
      pending: clients.reduce(
        (sum, client) => sum + client.pendingSyncs + client.pendingRequests,
        0,
      ),
      deliveredThrough: clients.length
        ? Math.min(...clients.map((client) => client.lastSeen))
        : null,
    };
  }
  events(actor: string, from: number, to: number): ProbeEvent[] {
    const collector = this.collectors.get(actor);
    if (!collector) return [];
    collector.touched = Date.now();
    return collector.events.filter((event) => event.start >= from && event.start <= to);
  }
  read(actor: string, after: number, limit: number, only?: ReadonlyArray<ProbeEventKind>) {
    const collector = this.collectors.get(actor);
    if (!collector) return [];
    collector.touched = Date.now();
    const filter = only?.length ? new Set<string>(only) : null;
    return collector.events
      .filter((event) => event.sequence > after && (!filter || filter.has(event.kind)))
      .slice(0, limit);
  }
  status(actor: string): ProbeStatus {
    const collector = this.collectors.get(actor);
    return {
      armed: Boolean(collector),
      listening: Boolean(this.server?.listening),
      port: this.listeningPort,
      unavailable: this.unavailable,
      clients: this.connectedClients().slice(0, 20),
      nextSequence: collector?.sequence ?? 0,
      dropped: collector?.dropped ?? 0,
      summary: summarize(collector?.events ?? []),
    };
  }
  // One page batch. Returns whether any collector wants events, which switches the
  // page between idle polling and streaming.
  ingest(body: unknown): { armed: boolean } {
    const value = record(body);
    const info = record(value.client);
    const id = string(info.id).slice(0, 120);
    if (!/^[a-zA-Z0-9-]{8,120}$/.test(id)) throw fail("invalid_command");
    const received = Date.now();
    const sent = number(value.sent);
    const client: Client = {
      id,
      page: debugURL(string(info.page)),
      title: redactDebugText(string(info.title), 200),
      office: string(info.office) ? redactDebugText(string(info.office), 200) : null,
      connected: true,
      firstSeen: this.clients.get(id)?.firstSeen ?? received,
      // Page clock; events up to here have been sent.
      lastSeen: Math.abs(sent - received) < 60_000 ? Math.min(sent, received) : received,
      pendingSyncs: Math.max(0, Math.min(10_000, Math.round(number(info.pendingSyncs)))),
      pendingRequests: Math.max(0, Math.min(10_000, Math.round(number(info.pendingRequests)))),
      loadedAfterMs: Number.isFinite(info.loadedAfter)
        ? Math.round(number(info.loadedAfter))
        : null,
      droppedEvents:
        (this.clients.get(id)?.droppedEvents ?? 0) + Math.max(0, Math.round(number(value.dropped))),
      touched: received,
    };
    this.clients.delete(id);
    this.clients.set(id, client);
    if (this.clients.size > 20) this.clients.delete(this.clients.keys().next().value!);
    if (!this.collectors.size) return { armed: false };
    const events = array(value.events)
      .slice(0, 500)
      .flatMap((raw) => normalizeProbeEvent(id, raw, received) ?? []);
    for (const collector of this.collectors.values()) {
      for (const event of events)
        collector.events.push({ ...event, sequence: ++collector.sequence });
      if (collector.events.length > MAX_EVENTS) {
        const excess = collector.events.length - MAX_EVENTS;
        collector.events.splice(0, excess);
        collector.dropped += excess;
      }
    }
    return { armed: true };
  }
  private handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const remote = request.socket.remoteAddress ?? "";
    const path = (request.url ?? "").split("?")[0];
    const reply = (status: number, body = "", type = "text/plain; charset=utf-8") => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    };
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return reply(403);
    if (request.method === "GET" && path === EXCEL_PROBE_SCRIPT_PATH)
      return reply(200, EXCEL_PROBE_SCRIPT, "text/javascript; charset=utf-8");
    if (request.method !== "POST" || path !== EXCEL_PROBE_EVENTS_PATH) return reply(404);
    if (request.headers[EXCEL_PROBE_HEADER] !== "1") return reply(403);
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reply(413);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY) return;
      try {
        reply(
          200,
          JSON.stringify(this.ingest(JSON.parse(Buffer.concat(chunks).toString("utf8")))),
          "application/json",
        );
      } catch {
        reply(400);
      }
    });
  }
}
