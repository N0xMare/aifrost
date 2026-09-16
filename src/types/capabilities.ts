export type Fidelity =
  "native_exact" | "native_approximate" | "emulated" | "unsupported" | "unobservable";

export type CapabilityTriState = true | false | "unknown";

export interface ProviderCapabilities {
  provider: string;
  adapterVersion: string;
  revision: string;
  observedAt: string;
  settingsSchema: Record<string, unknown>;
  operations: {
    newConversation: boolean;
    openConversation: boolean;
    cancelGeneration: boolean;
    attachments: CapabilityTriState | "unknown";
    builtInSearch: Fidelity | "native" | "unknown";
    artifacts: Fidelity | "native" | "unknown";
  };
  protocolFidelity: {
    systemRole: Fidelity;
    developerRole: Fidelity;
    arbitraryFunctionTools: Fidelity;
    usageTokens: Fidelity;
  };
  extensions?: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  adapterVersion: string;
  hosts: string[];
  status: "experimental" | "supported" | "degraded" | "disabled";
  capabilitiesRevision: string | null;
}
