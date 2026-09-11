import { supportedSnapshotIds, type SnapshotRegistry } from "./snapshots.js";

export interface SnapshotOverride {
  requested: string | null;
  question: string;
}

/** A leading `develop` or `v<major>.<minor>[.<patch>][-suffix]` token is an override. */
const OVERRIDE_RE = /^\s*(develop|v\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?)\s+/i;

export function parseSnapshotOverride(question: string): SnapshotOverride {
  const match = question.match(OVERRIDE_RE);
  if (!match) return { requested: null, question: question.trim() };
  return { requested: match[1], question: question.slice(match[0].length).trim() };
}

export interface VersionResolution {
  snapshotId: string;
  requested: string | null;
  supported: string[];
  unsupported: boolean;
  caveat: string | null;
}

function isDevelop(id: string): boolean {
  return id === "develop";
}

/**
 * The nearest answer to a request below the floor is the oldest supported release — the one
 * closest to what the partner is running.
 */
function nearestForUnsupported(supported: string[]): string {
  const releases = supported.filter((id) => !isDevelop(id));
  return releases.length > 0 ? releases[releases.length - 1] : "develop";
}

export function resolveSnapshot(args: {
  requested: string | null;
  defaultId?: string;
  registry: SnapshotRegistry;
}): VersionResolution {
  const fromRegistry = supportedSnapshotIds(args.registry);
  const supported = fromRegistry.length > 0 ? fromRegistry : ["develop"];
  const fallback = args.defaultId && supported.includes(args.defaultId) ? args.defaultId : "develop";

  if (!args.requested) {
    return { snapshotId: fallback, requested: null, supported, unsupported: false, caveat: null };
  }

  const wanted = args.requested.toLowerCase();
  const match =
    supported.find((id) => id.toLowerCase() === wanted) ??
    supported.find((id) => id.toLowerCase().startsWith(wanted));

  if (match) {
    return { snapshotId: match, requested: args.requested, supported, unsupported: false, caveat: null };
  }

  const nearest = nearestForUnsupported(supported);
  return {
    snapshotId: nearest,
    requested: args.requested,
    supported,
    unsupported: true,
    caveat:
      `Data2Evidence ${args.requested} is outside the supported range ` +
      `(${supported.join(", ")}). Answering from ${nearest} instead — ` +
      `version-specific details may differ.`,
  };
}
