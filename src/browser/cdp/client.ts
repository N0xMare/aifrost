/**
 * Typed raw CDP client over a single persistent WebSocket.
 * Shared by Chromium/Brave backends (and tests).
 *
 * Supports:
 * - monotonic command IDs
 * - pending promise registry + timeouts
 * - optional sessionId routing (flattened targets)
 * - event subscription
 * - socket failure propagation to pending commands
 */

import WebSocket from "ws";

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

export interface CdpEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

export type CdpEventHandler = (event: CdpEvent) => void;

export interface CdpClient {
  readonly connected: boolean;
  connect(wsUrl: string): Promise<void>;
  send<T = unknown>(cmd: CdpCommand, timeoutMs?: number): Promise<T>;
  onEvent(handler: CdpEventHandler): () => void;
  /** Fires when the underlying socket closes or fails after connect. */
  onClose(handler: (cause: Error) => void): () => void;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class RawCdpClient implements CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<CdpEventHandler>();
  private readonly closeHandlers = new Set<(cause: Error) => void>();
  private url: string | null = null;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(wsUrl: string): Promise<void> {
    if (this.connected && this.url === wsUrl) return;
    await this.closeSocketOnly();
    this.url = wsUrl;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const onOpen = () => {
        cleanupConnect();
        resolve();
      };
      const onError = (err: Error) => {
        cleanupConnect();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      // A clean close between TCP upgrade and "open" emits no "error" —
      // reject instead of leaving connect() pending forever.
      const onEarlyClose = () => {
        cleanupConnect();
        reject(new Error("CDP WebSocket closed before open"));
      };
      const cleanupConnect = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onEarlyClose);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onEarlyClose);

      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", () => this.onSocketClosed(new Error("CDP WebSocket closed")));
      ws.on("error", (err) => {
        // subsequent errors after open
        if (this.connected || this.pending.size) {
          this.onSocketClosed(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async send<T = unknown>(cmd: CdpCommand, timeoutMs = 30_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP not connected (method=${cmd.method})`);
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = {
      id,
      method: cmd.method,
      params: cmd.params ?? {},
    };
    if (cmd.sessionId) {
      message.sessionId = cmd.sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${cmd.method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method: cmd.method,
      });

      try {
        this.ws!.send(JSON.stringify(message));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (cause: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    await this.closeSocketOnly();
    this.handlers.clear();
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        const err = parsed.error as { message?: string; code?: number };
        pending.reject(
          new Error(
            `CDP error ${err.code ?? "?"} on ${pending.method}: ${err.message ?? JSON.stringify(parsed.error)}`,
          ),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (typeof parsed.method === "string") {
      const event: CdpEvent = {
        method: parsed.method,
        params: parsed.params,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      };
      for (const h of this.handlers) {
        try {
          h(event);
        } catch {
          // never let event handlers kill the client
        }
      }
    }
  }

  private onSocketClosed(cause: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${cause.message} (while waiting for ${p.method})`));
      this.pending.delete(id);
    }
    this.ws = null;
    for (const h of this.closeHandlers) {
      try {
        h(cause);
      } catch {
        // never let close handlers kill the client
      }
    }
  }

  private async closeSocketOnly(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP client closed"));
      this.pending.delete(id);
    }
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return;
    }
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
        return;
      }
      setTimeout(() => {
        // Half-open sockets must not leak file descriptors.
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve();
      }, 500);
    });
  }
}

/**
 * Discover the browser-level WebSocket URL from Chromium's /json/version.
 * (/json/list deliberately not used: it returns page-scoped WS URLs that
 * cannot serve Target.* commands.)
 */
export async function discoverBrowserWsUrl(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<string> {
  const base = `http://${host}:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          webSocketDebuggerUrl?: string;
          Browser?: string;
        };
        if (body.webSocketDebuggerUrl) {
          return rewriteWsHost(body.webSocketDebuggerUrl, host, port);
        }
      }
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }

  throw new Error(`CDP not ready at ${base} (no /json/version webSocketDebuggerUrl)`);
}

function rewriteWsHost(wsUrl: string, host: string, port: number): string {
  try {
    const u = new URL(wsUrl);
    // If browser advertises 0.0.0.0 or localhost variants, force configured host
    if (u.hostname === "0.0.0.0" || u.hostname === "::" || u.hostname === "[::]") {
      u.hostname = host;
    }
    if (!u.port) u.port = String(port);
    return u.toString();
  } catch {
    return `ws://${host}:${port}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
