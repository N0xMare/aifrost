import type { AgentEventEnvelope } from "../types/events.js";
import type { AgentId, EventId } from "../types/ids.js";
import { newEventId } from "../types/ids.js";

/** Bound on the in-memory backlog (events are also persisted for durability). */
const MAX_BUFFERED_EVENTS = 2_000;

export class AgentEventLog {
  private events: AgentEventEnvelope[] = [];
  private seq = 0;
  private listeners = new Set<(ev: AgentEventEnvelope) => void>();

  /**
   * Seed the seq floor after a restart so new events don't collide with
   * persisted (agent_id, seq) rows — INSERT OR IGNORE would silently drop them.
   */
  seedSeq(maxSeq: number): void {
    if (maxSeq > this.seq) this.seq = maxSeq;
  }

  append(
    agentId: AgentId,
    providerId: string,
    type: string,
    payload: unknown,
    generationId?: AgentEventEnvelope["generationId"],
  ): AgentEventEnvelope {
    this.seq += 1;
    const ev: AgentEventEnvelope = {
      id: newEventId() as EventId,
      seq: this.seq,
      type,
      timestamp: new Date().toISOString(),
      agentId,
      generationId,
      providerId,
      payload,
    };
    this.events.push(ev);
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    }
    for (const l of this.listeners) l(ev);
    return ev;
  }

  list(afterSeq = 0, limit = 1000): AgentEventEnvelope[] {
    return this.events.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  latestSeq(): number {
    return this.seq;
  }

  subscribe(listener: (ev: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Async iterator of events after seq, including live. */
  async *stream(afterSeq = 0, signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    let cursor = afterSeq;
    const pending: AgentEventEnvelope[] = [];
    let wake: (() => void) | null = null;

    const unsub = this.subscribe((ev) => {
      pending.push(ev);
      wake?.();
    });

    // Register the abort listener ONCE — a per-iteration listener leaks ~20/s
    // on a long-lived connection (MaxListenersExceededWarning).
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!signal?.aborted) {
        const backlog = this.list(cursor, 100);
        for (const ev of backlog) {
          cursor = ev.seq;
          yield ev;
        }
        while (pending.length) {
          const ev = pending.shift()!;
          if (ev.seq <= cursor) continue;
          cursor = ev.seq;
          yield ev;
        }
        if (signal?.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Idle poll fallback so stream can end on abort
          setTimeout(resolve, 50);
        });
        wake = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsub();
    }
  }
}
