/**
 * PageBridgeCore source injected via Page.addScriptToEvaluateOnNewDocument.
 *
 * Includes:
 * - ring buffer + drain/ack
 * - typed invoke dispatcher
 * - fetch/XHR/WebSocket/EventSource capture hooks
 * - fixture-web provider runtime (deterministic AI WebUI simulation)
 *
 * Kept as a string so it can be injected without a bundler step in M2/M3.
 * Do not put secrets or control-plane tokens into this script.
 */

export const PAGE_BRIDGE_VERSION = "0.2.0";

/** Document-start script body (no outer <script> tags). */
export const PAGE_BRIDGE_SOURCE = `
(function () {
  if (window.__AIFROST_BRIDGE__) return;

  var VERSION = ${JSON.stringify(PAGE_BRIDGE_VERSION)};
  var MAX_BUFFER = 2000;
  var seq = 0;
  var acked = 0;
  var overflow = false;
  var buffer = [];
  var networkCaptures = [];

  function now() {
    return new Date().toISOString();
  }

  function emit(type, payload) {
    if (overflow) return;
    seq += 1;
    if (buffer.length >= MAX_BUFFER) {
      overflow = true;
      buffer.push({
        seq: seq,
        type: "bridge.error",
        payload: { error: "event_buffer_overflow" },
        timestamp: now(),
      });
      return;
    }
    buffer.push({
      seq: seq,
      type: type,
      payload: payload == null ? null : payload,
      timestamp: now(),
    });
  }

  // ── Fixture store (provider runtime for fixture-web) ──────────────
  var store = {
    settings: { model_or_mode: "fixture-default", reasoning: { effort: "medium" } },
    history: [],
    conversationId: null,
    title: null,
    activeGenerationId: null,
    cancelRequested: false,
    streamTokens: [],
  };

  function invoke(command) {
    var type = String(command && command.type || "");
    try {
      switch (type) {
        case "provider.detect":
          return {
            accepted: true,
            result: {
              providerId: "fixture-web",
              matched: true,
              buildFingerprint: "fixture-bridge-" + VERSION,
            },
          };
        case "agent.inspect":
          return {
            accepted: true,
            result: {
              auth: "authenticated",
              ready: true,
              conversation: {
                providerConversationId: store.conversationId,
                title: store.title,
                turnCount: store.history.filter(function (m) { return m.role === "user"; }).length,
              },
              settings: Object.assign({}, store.settings),
              providerBuildFingerprint: "fixture-bridge-" + VERSION,
            },
          };
        case "agent.apply_settings": {
          var desired = (command && command.settings) || {};
          for (var k in desired) {
            if (Object.prototype.hasOwnProperty.call(desired, k)) {
              store.settings[k] = desired[k];
            }
          }
          emit("settings.applied", {
            desired: store.settings,
            effective: store.settings,
            warnings: [],
          });
          return {
            accepted: true,
            result: {
              desired: store.settings,
              effective: Object.assign({}, store.settings),
              warnings: [],
              mismatches: [],
            },
          };
        }
        case "conversation.new": {
          store.conversationId = "fix_conv_" + Date.now();
          store.title = "New fixture conversation";
          store.history = [];
          emit("conversation.changed", {
            providerConversationId: store.conversationId,
            title: store.title,
          });
          return {
            accepted: true,
            result: { providerConversationId: store.conversationId },
          };
        }
        case "conversation.open": {
          var ref = (command && command.ref) || {};
          store.conversationId = ref.providerConversationId || store.conversationId;
          return {
            accepted: true,
            result: { providerConversationId: store.conversationId },
          };
        }
        case "generation.start": {
          var generationId = String(command.generationId);
          var inputText = String(command.inputText || "");
          store.activeGenerationId = generationId;
          store.cancelRequested = false;
          store.history.push({ id: "u_" + generationId, role: "user", text: inputText });
          emit("generation.accepted", { generationId: generationId });
          var reply = "Echo: " + inputText;
          store.streamTokens = reply.split(/(\\s+)/).filter(function (t) { return t.length; });
          return { accepted: true, result: { generationId: generationId } };
        }
        case "generation.pump": {
          var gid = store.activeGenerationId;
          if (!gid) return { accepted: false };
          if (store.cancelRequested) {
            emit("generation.cancelled", { generationId: gid });
            store.activeGenerationId = null;
            return { accepted: true, result: { done: true, cancelled: true } };
          }
          var next = store.streamTokens.shift();
          if (next === undefined) {
            var lastUser = "";
            for (var i = store.history.length - 1; i >= 0; i--) {
              if (store.history[i].role === "user") {
                lastUser = store.history[i].text;
                break;
              }
            }
            var text = "Echo: " + lastUser;
            store.history.push({ id: "a_" + gid, role: "assistant", text: text });
            emit("generation.completed", { generationId: gid, text: text });
            store.activeGenerationId = null;
            return { accepted: true, result: { done: true } };
          }
          emit("generation.text.delta", { generationId: gid, text: next });
          return { accepted: true, result: { done: false, token: next } };
        }
        case "generation.cancel": {
          store.cancelRequested = true;
          return { accepted: true };
        }
        case "history.snapshot":
          return {
            accepted: true,
            result: {
              messages: store.history.map(function (m) {
                return { id: m.id, role: m.role, text: m.text };
              }),
            },
          };
        case "runtime.health":
          return { accepted: true, result: { ok: true, networkCaptures: networkCaptures.length } };
        case "network.captures":
          return { accepted: true, result: { captures: networkCaptures.slice(-50) } };
        case "network.clear":
          networkCaptures = [];
          return { accepted: true };
        default:
          return { accepted: false, result: { error: "unknown command " + type } };
      }
    } catch (e) {
      emit("bridge.error", { commandId: command && command.id, error: String(e && e.message || e) });
      return { accepted: false, result: { error: String(e && e.message || e) } };
    }
  }

  function drain(afterSeq, maxEvents) {
    var out = [];
    var max = maxEvents || 100;
    for (var i = 0; i < buffer.length && out.length < max; i++) {
      if (buffer[i].seq > afterSeq) out.push(buffer[i]);
    }
    return { events: out, latestSeq: seq, overflow: overflow };
  }

  function acknowledge(s) {
    acked = Math.max(acked, s | 0);
    while (buffer.length && buffer[0].seq <= acked) buffer.shift();
    // Unlatch once the host has drained below capacity — a page that once
    // overflowed must not stay mute forever.
    if (overflow && buffer.length < MAX_BUFFER) overflow = false;
  }

  function state() {
    return {
      ready: true,
      providerId: "fixture-web",
      seq: seq,
      acked: acked,
      overflow: overflow,
      bridgeVersion: VERSION,
    };
  }

  // ── Network interception (capture, non-mutating) ──────────────────
  function pushCapture(entry) {
    networkCaptures.push(entry);
    if (networkCaptures.length > 200) networkCaptures.shift();
    emit("network.capture", {
      kind: entry.kind,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      chunkCount: entry.chunkCount,
    });
  }

  // fetch
  if (typeof window.fetch === "function") {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      var started = Date.now();
      var chunks = 0;
      return origFetch(input, init).then(function (response) {
        try {
          var clone = response.clone();
          if (clone.body && typeof clone.body.getReader === "function") {
            var reader = clone.body.getReader();
            function pump() {
              return reader.read().then(function (result) {
                if (result.done) {
                  pushCapture({
                    kind: "fetch",
                    method: method,
                    url: url,
                    status: response.status,
                    chunkCount: chunks,
                    ms: Date.now() - started,
                  });
                  return;
                }
                chunks += 1;
                // Sampled only — per-chunk emits would flood the event buffer
                // on SSE streams (the final capture already reports chunkCount).
                if (chunks === 1 || chunks % 25 === 0) {
                  emit("network.fetch.chunk", {
                    url: url,
                    index: chunks,
                    byteLength: result.value && result.value.byteLength || 0,
                  });
                }
                return pump();
              });
            }
            pump().catch(function () {
              pushCapture({
                kind: "fetch",
                method: method,
                url: url,
                status: response.status,
                chunkCount: chunks,
                ms: Date.now() - started,
              });
            });
          } else {
            pushCapture({
              kind: "fetch",
              method: method,
              url: url,
              status: response.status,
              chunkCount: 0,
              ms: Date.now() - started,
            });
          }
        } catch (e) {
          /* ignore capture errors */
        }
        return response;
      });
    };
  }

  // XHR
  if (typeof window.XMLHttpRequest === "function") {
    var XHR = window.XMLHttpRequest;
    var open = XHR.prototype.open;
    var send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__aifrost = { method: method, url: String(url) };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      var meta = self.__aifrost || { method: "GET", url: "" };
      self.addEventListener("loadend", function () {
        pushCapture({
          kind: "xhr",
          method: meta.method,
          url: meta.url,
          status: self.status,
          chunkCount: 1,
        });
      });
      return send.apply(this, arguments);
    };
  }

  // WebSocket
  if (typeof window.WebSocket === "function") {
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      var meta = { kind: "websocket", url: String(url), messages: 0 };
      ws.addEventListener("message", function () {
        meta.messages += 1;
        if (meta.messages === 1 || meta.messages % 25 === 0) {
          emit("network.ws.message", { url: meta.url, index: meta.messages });
        }
      });
      ws.addEventListener("open", function () {
        pushCapture({ kind: "websocket", method: "WS", url: meta.url, status: 101, chunkCount: 0 });
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }

  // EventSource
  if (typeof window.EventSource === "function") {
    var OrigES = window.EventSource;
    window.EventSource = function (url, config) {
      var es = config !== undefined ? new OrigES(url, config) : new OrigES(url);
      var count = 0;
      es.addEventListener("message", function () {
        count += 1;
        if (count === 1 || count % 25 === 0) {
          emit("network.eventsource.message", { url: String(url), index: count });
        }
      });
      pushCapture({
        kind: "eventsource",
        method: "GET",
        url: String(url),
        status: 200,
        chunkCount: 0,
      });
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
    window.EventSource.CONNECTING = OrigES.CONNECTING;
    window.EventSource.OPEN = OrigES.OPEN;
    window.EventSource.CLOSED = OrigES.CLOSED;
  }

  window.__AIFROST_BRIDGE__ = {
    version: VERSION,
    state: state,
    invoke: invoke,
    drain: drain,
    acknowledge: acknowledge,
  };

  emit("bridge.ready", { bridgeVersion: VERSION });
})();
`;

/** Marker also recognized by MockBrowserBackend installer. */
export const PAGE_BRIDGE_INSTALL_SCRIPT = `/* AIFROST_PAGE_BRIDGE */\n${PAGE_BRIDGE_SOURCE}`;
