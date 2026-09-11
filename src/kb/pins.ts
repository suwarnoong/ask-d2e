export interface D2ePins {
  atlas3: string;
  trex: string;
}

export interface PinSources {
  atlasPackageJson: string;
  trexDockerfile: string;
}

const ATLAS3_PACKAGE = "@ohdsi/atlas3";
const SHORT_SHA_LENGTH = 7;

/** `0.1.0-20260823112941-269a00a` -> `269a00a`. The suffix is the upstream commit. */
const ATLAS_VERSION_RE = /-([0-9a-f]{7,40})$/;

/**
 * The trex ref appears in three shapes across releases:
 *   ARG TREXSQL_REF=prod-sha-5ce4275…@sha256:…   (develop, with a build-target prefix)
 *   ARG TREXSQL_REF=sha-5ce4275…@sha256:…        (unprefixed variant)
 *   FROM ghcr.io/ohdsi/trexsql:sha-dec4a95…@sha256:… AS base   (v0.17/v0.18 releases)
 */
const TREX_ARG_RE = /^\s*ARG\s+TREXSQL_REF=(\S+)\s*$/m;
const TREX_FROM_RE = /^\s*FROM\s+ghcr\.io\/ohdsi\/trexsql:(\S+)\s+AS\s+/m;
const TREX_SHA_RE = /(?:^|[-:])sha-([0-9a-f]{7,40})(?:@|$)/;

export function extractAtlas3Pin(packageJson: string): string {
  let parsed: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    parsed = JSON.parse(packageJson) as typeof parsed;
  } catch (err) {
    throw new Error(`Cannot parse the atlas package.json: ${(err as Error).message}`);
  }
  const version = parsed.dependencies?.[ATLAS3_PACKAGE] ?? parsed.devDependencies?.[ATLAS3_PACKAGE];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`No "${ATLAS3_PACKAGE}" pin found in plugins/atlas/package.json.`);
  }
  const match = version.trim().match(ATLAS_VERSION_RE);
  if (!match) {
    throw new Error(`Unrecognised "${ATLAS3_PACKAGE}" version format: "${version}".`);
  }
  return match[1].slice(0, SHORT_SHA_LENGTH);
}

export function extractTrexPin(dockerfile: string): string {
  const ref = dockerfile.match(TREX_ARG_RE)?.[1] ?? dockerfile.match(TREX_FROM_RE)?.[1];
  if (!ref) {
    throw new Error("No TREXSQL_REF build arg or trexsql base image found in services/trex/Dockerfile.v2.");
  }
  const match = ref.match(TREX_SHA_RE);
  if (!match) {
    throw new Error(`Unrecognised trex pin format: "${ref}".`);
  }
  return match[1].slice(0, SHORT_SHA_LENGTH);
}

export function extractPins(sources: PinSources): D2ePins {
  return {
    atlas3: extractAtlas3Pin(sources.atlasPackageJson),
    trex: extractTrexPin(sources.trexDockerfile),
  };
}
