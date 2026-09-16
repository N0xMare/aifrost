export interface SettingsSnapshot {
  desired: Record<string, unknown>;
  effective: Record<string, unknown>;
  revision: number;
  observedAt: string | null;
  capabilitiesRevision: string | null;
}

export interface SettingsApplyResult {
  desired: Record<string, unknown>;
  effective: Record<string, unknown>;
  revision: number;
  warnings: string[];
  mismatches: string[];
}

export function settingsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(stableSort(a)) === JSON.stringify(stableSort(b));
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = stableSort(obj[key]);
    }
    return out;
  }
  return value;
}

export function diffSettings(
  desired: Record<string, unknown>,
  effective: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(desired), ...Object.keys(effective)]);
  const mismatches: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(desired[key]) !== JSON.stringify(effective[key])) {
      mismatches.push(key);
    }
  }
  return mismatches;
}
