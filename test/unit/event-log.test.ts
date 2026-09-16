import { describe, expect, it } from "vitest";
import { AgentEventLog } from "../../src/core/event-log.js";
import type { AgentId } from "../../src/types/ids.js";

const AGENT = "agt_evt_test" as AgentId;

describe("AgentEventLog", () => {
  it("appends with monotonic seq and lists after cursor", () => {
    const log = new AgentEventLog();
    const a = log.append(AGENT, "fixture-web", "generation.started", {});
    const b = log.append(AGENT, "fixture-web", "output_text.delta", { d: "x" });
    expect(b.seq).toBe(a.seq + 1);
    expect(log.list(0).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.list(1).map((e) => e.seq)).toEqual([2]);
    expect(log.latestSeq()).toBe(2);
  });

  it("seedSeq keeps new events above persisted rows after restart", () => {
    const log = new AgentEventLog();
    log.seedSeq(100);
    const ev = log.append(AGENT, "fixture-web", "agent.ready", {});
    expect(ev.seq).toBe(101);
    // seedSeq is a floor, not a reset
    log.seedSeq(50);
    expect(log.append(AGENT, "fixture-web", "x", {}).seq).toBe(102);
  });

  it("bounds the in-memory backlog", () => {
    const log = new AgentEventLog();
    for (let i = 0; i < 2_100; i++) {
      log.append(AGENT, "fixture-web", "output_text.delta", { i });
    }
    expect(log.list(0, 10_000)).toHaveLength(2_000);
    expect(log.latestSeq()).toBe(2_100);
    // oldest retained is seq 101
    expect(log.list(0, 10_000)[0]?.seq).toBe(101);
  });

  it("stream() yields backlog once, then live events, and stops on abort", async () => {
    const log = new AgentEventLog();
    log.append(AGENT, "fixture-web", "generation.started", {});

    const ac = new AbortController();
    const seen: number[] = [];
    const reader = (async () => {
      for await (const ev of log.stream(0, ac.signal)) {
        seen.push(ev.seq);
        if (seen.length === 1) {
          log.append(AGENT, "fixture-web", "output_text.delta", { d: "live" });
          ac.abort();
        }
      }
    })();
    await reader;
    // backlog event (seq 1) + live event (seq 2), each exactly once
    expect(seen).toEqual([1, 2]);
  });
});
