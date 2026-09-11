import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SnapshotStatus = "active" | "retired" | "building";

export interface SnapshotEntry {
  id: string;
  d2eTag: string;
  pins: { atlas3: string; trex: string };
  status: SnapshotStatus;
  builtAt: string;
  isDevelop: boolean;
}

export interface SnapshotRegistry {
  snapshots: SnapshotEntry[];
}

/** The spec's supported set: develop plus the two most recent releases. */
export const MAX_ACTIVE_RELEASES = 2;

const REGISTRY_FILE = "snapshots.json";
const STATUSES: SnapshotStatus[] = ["active", "retired", "building"];
const RELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)/;

export function emptyRegistry(): SnapshotRegistry {
  return { snapshots: [] };
}

function fail(message: string): never {
  throw new Error(`Invalid snapshots.json: ${message}`);
}

function parseEntry(value: unknown): SnapshotEntry {
  if (typeof value !== "object" || value === null) fail("an entry is not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id === "") fail("an entry has no id");
  if (typeof v.d2eTag !== "string" || v.d2eTag === "") fail(`${v.id} has no d2eTag`);
  if (typeof v.builtAt !== "string") fail(`${v.id} has no builtAt`);
  if (typeof v.isDevelop !== "boolean") fail(`${v.id} has no isDevelop flag`);
  if (typeof v.status !== "string" || !STATUSES.includes(v.status as SnapshotStatus)) {
    fail(`${v.id} has an unknown status: ${String(v.status)}`);
  }
  const pins = v.pins as Record<string, unknown> | undefined;
  if (!pins || typeof pins.atlas3 !== "string" || typeof pins.trex !== "string") {
    fail(`${v.id} has no complete pins object`);
  }
  return {
    id: v.id,
    d2eTag: v.d2eTag,
    pins: { atlas3: pins.atlas3, trex: pins.trex },
    status: v.status as SnapshotStatus,
    builtAt: v.builtAt,
    isDevelop: v.isDevelop,
  };
}

export function parseSnapshotRegistry(raw: string): SnapshotRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`not valid JSON: ${(err as Error).message}`);
  }
  const snapshots = (parsed as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(snapshots)) fail("no snapshots array");
  return { snapshots: snapshots.map(parseEntry) };
}

export function loadSnapshotRegistry(kbRoot: string): SnapshotRegistry {
  let raw: string;
  try {
    raw = readFileSync(join(kbRoot, REGISTRY_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw err;
  }
  return parseSnapshotRegistry(raw);
}

export function writeSnapshotRegistry(kbRoot: string, registry: SnapshotRegistry): void {
  writeFileSync(join(kbRoot, REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`);
}

/** Releases sort by version descending; develop always leads. */
function releaseOrder(id: string): number[] {
  const match = id.match(RELEASE_RE);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [-1, -1, -1];
}

function compareReleasesDesc(a: string, b: string): number {
  const [am, an, ap] = releaseOrder(a);
  const [bm, bn, bp] = releaseOrder(b);
  return bm - am || bn - an || bp - ap;
}

export function supportedSnapshotIds(registry: SnapshotRegistry): string[] {
  const active = registry.snapshots.filter((s) => s.status === "active");
  const develop = active.filter((s) => s.isDevelop).map((s) => s.id);
  const releases = active.filter((s) => !s.isDevelop).map((s) => s.id).sort(compareReleasesDesc);
  return [...develop, ...releases];
}

export function registerSnapshot(registry: SnapshotRegistry, entry: SnapshotEntry): SnapshotRegistry {
  const withoutSameId = registry.snapshots.filter((s) => s.id !== entry.id);
  const next = [...withoutSameId, entry];

  const releases = next
    .filter((s) => !s.isDevelop && s.status === "active")
    .map((s) => s.id)
    .sort(compareReleasesDesc);
  const keep = new Set(releases.slice(0, MAX_ACTIVE_RELEASES));

  return {
    snapshots: next.map((s) =>
      !s.isDevelop && s.status === "active" && !keep.has(s.id)
        ? { ...s, status: "retired" as const }
        : { ...s },
    ),
  };
}
