// Served to an Office add-in's development build through its dev-server proxy. It runs in
// the add-in's own WebKit page, so it observes Office.js, network and timing exactly as the
// add-in experiences them. It never navigates, changes requests or responses, or reads
// request bodies, headers or cookies. Until Cinderdeck arms a collector it only keeps a
// bounded local buffer and polls; nothing leaves the page except to its own dev server.
// Keep this plain browser JavaScript: no template literals, so it embeds verbatim.
export const EXCEL_PROBE_SCRIPT = `/* Cinderdeck Excel performance probe (development only) */
(function () {
  "use strict";
  var g = typeof globalThis !== "undefined" ? globalThis : self;
  if (g.__cinderdeckProbe) return;
  var perf = g.performance;
  var origin = perf && perf.timeOrigin ? perf.timeOrigin : Date.now() - (perf ? perf.now() : 0);
  function now() { return perf ? origin + perf.now() : Date.now(); }
  function at(relative) { return origin + relative; }
  var script = typeof document !== "undefined" ? document.currentScript : null;
  var base = script && script.src ? new URL(".", script.src).href : new URL("/__cinderdeck/", g.location.href).href;
  var endpoint = base + "excel-probe/events";
  var clientId = g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : String(Math.random()).slice(2) + String(Date.now());
  var nativeFetch = typeof g.fetch === "function" ? g.fetch.bind(g) : null;
  var queue = [], dropped = 0, armed = false, office = null, loadedAfter = perf ? perf.now() : null;
  var pendingSyncs = 0, pendingRequests = 0, inflight = false, timer = null, backoff = 1000;
  var MAX_QUEUE = 2000;
  function push(event) {
    if (queue.length >= MAX_QUEUE) { queue.shift(); dropped++; }
    queue.push(event);
    if (armed && queue.length >= 200) flush();
  }
  function own(url) { return typeof url === "string" && url.indexOf("/__cinderdeck/") >= 0; }
  function clean(raw) {
    try { var u = new URL(String(raw), g.location.href); return u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : u.protocol; }
    catch (e) { return ""; }
  }
  function describe(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value) return (value.name || "Error") + ": " + value.message + (value.code ? " (" + value.code + ")" : "");
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function code(error) {
    if (!error) return "";
    var location = error.debugInfo && error.debugInfo.errorLocation ? " at " + error.debugInfo.errorLocation : "";
    return String(error.code || error.name || "Error") + location;
  }
  function settle(result, ok, failed) {
    return result && typeof result.then === "function" ? result.then(function (value) { ok(); return value; }, function (error) { failed(error); throw error; }) : (ok(), result);
  }

  // Office.js: request batches and their round trips to the host.
  var contexts = typeof WeakMap === "function" ? new WeakMap() : null, runSequence = 0, officeHooked = false;
  function instrumentOffice() {
    var extension = g.OfficeExtension;
    var proto = extension && extension.ClientRequestContext && extension.ClientRequestContext.prototype;
    if (proto && typeof proto.sync === "function" && !proto.sync.__cinderdeck) {
      var sync = proto.sync;
      var wrappedSync = function () {
        var actions;
        try {
          var request = this.m_pendingRequest;
          var list = request && (request.m_actions || request._actions);
          if (list && typeof list.length === "number") actions = list.length;
        } catch (e) {}
        var run = contexts ? contexts.get(this) : null;
        if (run) run.syncs++;
        var t0 = now();
        pendingSyncs++;
        var done = function (ok, error) {
          pendingSyncs = Math.max(0, pendingSyncs - 1);
          push({ k: "sync", t0: t0, t1: now(), n: run ? "run " + run.id : "", c: actions, ok: ok, x: ok ? "" : code(error) });
        };
        var result;
        try { result = sync.apply(this, arguments); } catch (error) { done(false, error); throw error; }
        return settle(result, function () { done(true); }, function (error) { done(false, error); });
      };
      wrappedSync.__cinderdeck = true;
      proto.sync = wrappedSync;
    }
    ["Excel", "Word", "PowerPoint", "OneNote", "Visio"].forEach(function (host) {
      var ns = g[host];
      if (!ns || typeof ns.run !== "function" || ns.run.__cinderdeck) return;
      var run = ns.run;
      var wrappedRun = function () {
        var args = Array.prototype.slice.call(arguments), index = args.length - 1, batch = args[index];
        if (typeof batch !== "function") return run.apply(this, arguments);
        var info = { id: ++runSequence, syncs: 0 }, t0 = now();
        args[index] = function (context) {
          try { if (contexts && context && typeof context === "object") contexts.set(context, info); } catch (e) {}
          return batch.apply(this, arguments);
        };
        var finish = function (ok, error) { push({ k: "run", t0: t0, t1: now(), n: host + " run " + info.id, c: info.syncs, ok: ok, x: ok ? "" : code(error) }); };
        return settle(run.apply(this, args), function () { finish(true); }, function (error) { finish(false, error); });
      };
      wrappedRun.__cinderdeck = true;
      try { ns.run = wrappedRun; } catch (e) {}
    });
    if (g.Office && typeof g.Office.onReady === "function" && !officeHooked) {
      officeHooked = true;
      try {
        g.Office.onReady().then(function (info) {
          var diagnostics = null;
          try { diagnostics = g.Office.context && g.Office.context.diagnostics; } catch (e) {}
          office = [info && info.host, (info && info.platform) || (diagnostics && diagnostics.platform), diagnostics && diagnostics.version].filter(Boolean).join(" ");
          push({ k: "ready", t: now(), x: office });
          instrumentOffice();
        });
      } catch (e) {}
    }
  }
  instrumentOffice();
  var officePolls = 0, officeTimer = setInterval(function () {
    instrumentOffice();
    if (++officePolls > 120) clearInterval(officeTimer);
  }, 250);

  // Network: status and failures from fetch/XHR; phases and sizes from Resource Timing.
  function pending(delta) { pendingRequests = Math.max(0, pendingRequests + delta); }
  if (nativeFetch) {
    g.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      if (own(url)) return nativeFetch(input, init);
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var t0 = now();
      pending(1);
      return nativeFetch(input, init).then(function (response) {
        pending(-1);
        var length = Number(response.headers.get("content-length"));
        push({ k: "fetch", t0: t0, t1: now(), n: clean(url), x: method, s: response.status, ok: response.ok, b: isFinite(length) && length >= 0 ? length : undefined });
        return response;
      }, function (error) {
        pending(-1);
        push({ k: "fetch", t0: t0, t1: now(), n: clean(url), x: method + " " + describe(error), s: 0, ok: false });
        throw error;
      });
    };
  }
  if (typeof XMLHttpRequest === "function") {
    var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cinderdeck = { m: String(method).toUpperCase(), u: String(url) };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var info = this.__cinderdeck, xhr = this;
      if (info && !own(info.u)) {
        var t0 = now();
        pending(1);
        xhr.addEventListener("loadend", function () {
          pending(-1);
          var length = Number(xhr.getResponseHeader && xhr.getResponseHeader("content-length"));
          push({ k: "xhr", t0: t0, t1: now(), n: clean(info.u), x: info.m, s: xhr.status, ok: xhr.status >= 200 && xhr.status < 400, b: isFinite(length) && length >= 0 ? length : undefined });
        });
      }
      return send.apply(this, arguments);
    };
  }
  function phases(entry) {
    var part = function (label, a, b) { return a > 0 && b >= a ? label + "=" + Math.round(b - a) : ""; };
    return [
      entry.initiatorType || entry.entryType,
      part("dns", entry.domainLookupStart, entry.domainLookupEnd),
      part("connect", entry.connectStart, entry.connectEnd),
      part("tls", entry.secureConnectionStart, entry.connectEnd),
      part("ttfb", entry.requestStart, entry.responseStart),
      part("download", entry.responseStart, entry.responseEnd),
      entry.transferSize === 0 && entry.decodedBodySize > 0 ? "cache" : ""
    ].filter(Boolean).join(" ");
  }
  function observe(type, handle) {
    try { new PerformanceObserver(function (list) { list.getEntries().forEach(handle); }).observe({ type: type, buffered: true }); } catch (e) {}
  }
  try { if (perf && perf.setResourceTimingBufferSize) perf.setResourceTimingBufferSize(1000); } catch (e) {}
  observe("resource", function (entry) {
    if (own(entry.name)) return;
    push({ k: "resource", t0: at(entry.startTime), t1: at(entry.responseEnd || entry.startTime + entry.duration), n: clean(entry.name), x: phases(entry), b: entry.transferSize || 0 });
  });
  observe("navigation", function (entry) {
    var detail = [phases(entry), "domContentLoaded=" + Math.round(entry.domContentLoadedEventEnd), "load=" + Math.round(entry.loadEventEnd)].join(" ");
    push({ k: "navigation", t0: at(entry.startTime), t1: at(entry.loadEventEnd || entry.duration), n: clean(entry.name), x: detail, b: entry.transferSize || 0 });
  });
  observe("paint", function (entry) { push({ k: "paint", t: at(entry.startTime), n: entry.name }); });
  observe("mark", function (entry) { push({ k: "mark", t: at(entry.startTime), n: entry.name }); });
  observe("measure", function (entry) { push({ k: "measure", t0: at(entry.startTime), t1: at(entry.startTime + entry.duration), n: entry.name }); });

  // Console and failures. Blackbox this script in Web Inspector to keep original call sites.
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = g.console && g.console[level];
    if (typeof original !== "function") return;
    g.console[level] = function () {
      try { push({ k: "console", t: now(), l: level, x: Array.prototype.slice.call(arguments, 0, 10).map(describe).join(" ").slice(0, 2000) }); } catch (e) {}
      return original.apply(this, arguments);
    };
  });
  if (typeof g.addEventListener === "function") {
    g.addEventListener("error", function (event) {
      push({ k: "error", t: now(), x: describe(event.error || event.message), n: event.filename ? clean(event.filename) + ":" + event.lineno : "" });
    });
    g.addEventListener("unhandledrejection", function (event) { push({ k: "error", t: now(), x: "Unhandled rejection: " + describe(event.reason) }); });
  }

  // Main-thread stalls (WebKit has no Long Tasks API): timer drift beyond 50 ms while visible.
  var tick = perf ? perf.now() : 0;
  setInterval(function () {
    if (!perf) return;
    var current = perf.now(), lag = current - tick - 100;
    if (armed && lag > 50 && (typeof document === "undefined" || document.visibilityState === "visible")) push({ k: "jank", t0: at(tick + 100), t1: at(current) });
    tick = current;
  }, 100);

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, armed ? 250 : backoff);
  }
  function flush() {
    if (inflight || !nativeFetch) return;
    inflight = true;
    var events = armed ? queue.splice(0, 500) : [];
    var body = JSON.stringify({
      v: 1, sent: now(), dropped: dropped, events: events,
      client: { id: clientId, page: clean(g.location.href), title: typeof document !== "undefined" ? String(document.title).slice(0, 200) : "", office: office, loadedAfter: loadedAfter, pendingSyncs: pendingSyncs, pendingRequests: pendingRequests }
    });
    nativeFetch(endpoint, { method: "POST", body: body, credentials: "omit", cache: "no-store", keepalive: body.length < 60000, headers: { "content-type": "text/plain", "x-cinderdeck-probe": "1" } })
      .then(function (response) { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .then(function (reply) {
        if (events.length) dropped = 0;
        var wasArmed = armed;
        armed = !!(reply && reply.armed);
        backoff = 1000;
        if (armed && !wasArmed) setTimeout(flush, 0);
      }, function () {
        if (events.length) queue = events.concat(queue).slice(-MAX_QUEUE);
        armed = false;
        backoff = Math.min(backoff * 2, 10000);
      })
      .then(function () { inflight = false; schedule(); });
  }
  if (typeof g.addEventListener === "function") g.addEventListener("pagehide", function () { if (armed) { inflight = false; flush(); } });
  push({ k: "probe", t: now(), x: "Probe loaded " + Math.round(loadedAfter || 0) + " ms after navigation start" });
  g.__cinderdeckProbe = {
    version: 1,
    clientId: clientId,
    mark: function (name) { if (perf && perf.mark) perf.mark(String(name)); },
    time: function (name, task) {
      var start = String(name) + ":start";
      if (perf && perf.mark) perf.mark(start);
      var finish = function () { try { perf.measure(String(name), start); } catch (e) {} };
      try { return settle(task(), finish, finish); } catch (error) { finish(); throw error; }
    }
  };
  flush();
})();
//# sourceURL=cinderdeck-excel-probe.js
`;
