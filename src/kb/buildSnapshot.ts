import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPins } from "./pins.js";
import { buildDocsTier } from "./buildDocsTier.js";
import {
  loadSnapshotRegistry,
  registerSnapshot,
  writeSnapshotRegistry,
  type SnapshotEntry,
} from "./snapshots.js";

/** Where each pin and the docs site live inside a Data2Evidence checkout. */
export const PIN_SOURCE_PATHS = {
  atlasPackageJson: "plugins/atlas/package.json",
  trexDockerfile: "services/trex/Dockerfile.v2",
  docsRoot: "docs/website/docs",
} as const;

export interface PinSourceBundle {
  atlasPackageJson: string;
  trexDockerfile: string;
  docsRoot: string;
}

export interface SnapshotBuildInput extends PinSourceBundle {
  kbRoot: string;
  snapshotId: string;
  d2eTag: string;
  isDevelop: boolean;
  builtAt?: string;
}

export interface SnapshotBuildResult {
  entry: SnapshotEntry;
  docsWritten: number;
  troubleshootingEntries: number;
  manifestEntries: number;
}

export function readPinSources(d2eRoot: string): PinSourceBundle {
  return {
    atlasPackageJson: readFileSync(join(d2eRoot, PIN_SOURCE_PATHS.atlasPackageJson), "utf8"),
    trexDockerfile: readFileSync(join(d2eRoot, PIN_SOURCE_PATHS.trexDockerfile), "utf8"),
    docsRoot: join(d2eRoot, PIN_SOURCE_PATHS.docsRoot),
  };
}

/**
 * One snapshot build, in the order the spec requires: extract the pins first (a checkout that
 * declares no pins must abort with the registry untouched), then the deterministic docs tier,
 * then register. Tier-3 generation and the release workflow are phases E and F.
 */
export function buildSnapshot(input: SnapshotBuildInput): SnapshotBuildResult {
  const pins = extractPins({
    atlasPackageJson: input.atlasPackageJson,
    trexDockerfile: input.trexDockerfile,
  });

  const docs = buildDocsTier({
    docsRoot: input.docsRoot,
    kbRoot: input.kbRoot,
    snapshotId: input.snapshotId,
  });
  if (docs.docsWritten === 0) {
    throw new Error(
      `No documentation found under ${input.docsRoot}; refusing to register an empty snapshot.`,
    );
  }

  const entry: SnapshotEntry = {
    id: input.snapshotId,
    d2eTag: input.d2eTag,
    pins,
    status: "active",
    builtAt: input.builtAt ?? new Date().toISOString(),
    isDevelop: input.isDevelop,
  };
  writeSnapshotRegistry(input.kbRoot, registerSnapshot(loadSnapshotRegistry(input.kbRoot), entry));

  return {
    entry,
    docsWritten: docs.docsWritten,
    troubleshootingEntries: docs.troubleshootingEntries,
    manifestEntries: docs.manifestEntries,
  };
}
