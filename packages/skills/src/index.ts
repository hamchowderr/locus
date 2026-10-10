import type { GhlOperation } from "@locus/ghl";

/** What every generated skill exports from its `manifest.ts`. */
export interface SkillManifest {
  /** The GHL service name as the live docs spell it, e.g. `opportunities`. */
  readonly category: string;
  /** One line the harness shows when deciding which skill to load. */
  readonly summary: string;
  readonly operations: readonly GhlOperation[];
}

export function defineSkill<const T extends SkillManifest>(manifest: T): T {
  return manifest;
}
