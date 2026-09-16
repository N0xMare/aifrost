import type { BrowserBackend } from "../browser/backend.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AgentId } from "../types/ids.js";
import { err } from "../types/errors.js";
import { AgentActor } from "./agent-actor.js";
import type { CreateAgentRequest } from "../types/generation.js";
import type { AccountId } from "../types/ids.js";
import type { AgentStore } from "../persistence/repositories.js";
import { logger } from "../observability/logger.js";
import type { AccountRateLimitController } from "./account-rate-limit.js";

export class AgentRegistry {
  private actors = new Map<AgentId, AgentActor>();

  constructor(
    private readonly browser: BrowserBackend,
    private readonly providers: ProviderRegistry,
    private readonly store: AgentStore | null = null,
    private readonly rateLimiter: AccountRateLimitController | null = null,
  ) {}

  /**
   * Reload non-deleted agents from durable store into memory.
   * Does NOT auto-start browser runtimes; actors stay ready but detached.
   */
  loadFromStore(): number {
    if (!this.store) return 0;
    const bundles = this.store.listBundles();
    let loaded = 0;
    for (const bundle of bundles) {
      if (this.actors.has(bundle.agent.id)) continue;
      const actor = AgentActor.fromPersisted(
        this.browser,
        this.providers,
        bundle.agent,
        bundle.history,
        this.store,
        this.rateLimiter,
      );
      // Reseed the in-memory seq above persisted rows — otherwise post-restart
      // events collide on (agent_id, seq) and INSERT OR IGNORE drops them.
      actor.events.seedSeq(this.store.maxEventSeq(bundle.agent.id));
      this.actors.set(actor.agentId, actor);
      loaded += 1;
    }
    if (loaded > 0) {
      logger.info({ count: loaded }, "reloaded agents from store (browser detached)");
    }
    return loaded;
  }

  async create(request: CreateAgentRequest): Promise<AgentActor> {
    // Ensure provider is registered (chatgpt-web is live; may still report login_required)
    this.providers.get(request.provider);

    const actor = new AgentActor(
      this.browser,
      this.providers,
      {
        providerId: request.provider,
        accountId: (request.account_id as AccountId) ?? ("acct_default" as AccountId),
      },
      this.store,
      this.rateLimiter,
    );
    await actor.create(request);
    this.actors.set(actor.agentId, actor);
    return actor;
  }

  get(agentId: AgentId): AgentActor {
    const actor = this.actors.get(agentId);
    if (!actor || actor.snapshot().agent.lifecycle === "deleted") {
      throw err("agent_not_found", `Unknown agent: ${agentId}`, 404, { agentId });
    }
    return actor;
  }

  list(filter?: { provider?: string; lifecycle?: string }): AgentActor[] {
    return [...this.actors.values()].filter((a) => {
      const s = a.snapshot().agent;
      if (s.lifecycle === "deleted") return false;
      if (filter?.provider && s.providerId !== filter.provider) return false;
      if (filter?.lifecycle && s.lifecycle !== filter.lifecycle) return false;
      return true;
    });
  }

  async delete(agentId: AgentId): Promise<void> {
    const actor = this.get(agentId);
    try {
      await actor.delete();
    } finally {
      // delete() marks the actor deleted even if runtime teardown failed —
      // never leave it registered where get() would keep seeing it.
      this.actors.delete(agentId);
    }
  }
}
