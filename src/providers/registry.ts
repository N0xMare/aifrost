import type { ProviderWebUIAdapter } from "./contract.js";
import type { ProviderDefinition } from "../types/capabilities.js";
import { FixtureWebAdapter } from "./fixture-web/adapter.js";
import { ChatGptWebAdapter } from "./chatgpt-web/adapter.js";
import { err } from "../types/errors.js";

export class ProviderRegistry {
  private adapters = new Map<string, ProviderWebUIAdapter>();

  register(adapter: ProviderWebUIAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(providerId: string): ProviderWebUIAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw err("provider_not_found", `Unknown provider: ${providerId}`, 404, {
        providerId,
      });
    }
    return adapter;
  }

  list(): ProviderDefinition[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      displayName: a.id,
      adapterVersion: a.version,
      hosts: a.hosts,
      status: a.id === "fixture-web" ? "supported" : "experimental",
      capabilitiesRevision: null,
    }));
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new FixtureWebAdapter());
  registry.register(new ChatGptWebAdapter());
  return registry;
}
