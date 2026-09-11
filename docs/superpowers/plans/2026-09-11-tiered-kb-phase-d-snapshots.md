# Tiered KB Phase D — Snapshot Machinery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the version axis real: extract the dependency pins a D2E release declares, build a per-release snapshot of the official docs, register snapshots in `snapshots.json`, and route each question to the snapshot it belongs to.

**Architecture:** A snapshot is one D2E release with its dependencies resolved to what that release pinned. Phase C already proved snapshot-shaped tier-2 output (`docs/`, `troubleshooting.md`, `manifest.json`) for `develop`. Phase D adds the three pieces that make more than one snapshot possible and correct: a pin extractor that reads what a tag declares and fails loudly when it cannot, a registry that records which snapshots exist and which are supported, and version routing so a partner asking about a specific release is answered from that release.

**Tech Stack:** Node >=20, TypeScript ^5.5, ESM (`"type": "module"`, NodeNext), `tsx`, Node's built-in `node:test` / `node:assert/strict`. No new runtime or test dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-multi-repo-tiered-kb-design.md`
**Predecessor:** `docs/superpowers/plans/2026-09-11-tiered-kb-phases-a-c.md` (phases A–C, shipped to `main` on 2026-09-11)

---

## Facts this plan is built on (re-verified 2026-09-11)

Read from the reference clones, plus a temp clone of `v0.18.0-beta` (our shallow clone does not carry it):

| D2E ref | `@ohdsi/atlas3` pin | trex pin | docs md |
|---|---|---|---|
| `develop` | `0.1.0-20260823112941-269a00a` → `269a00a` | `ARG TREXSQL_REF=prod-sha-5ce42757279f969bca123f0128a5c967ff2e3bd4@sha256:…` → `5ce4275` | 53 |
| `v0.18.1-beta` | `0.1.0-20260817035540-9baa99a` → `9baa99a` | `FROM ghcr.io/ohdsi/trexsql:sha-dec4a9508dcc57597c64422d6a27a36daaf74e27@sha256:… AS base` → `dec4a95` | 53 |
| `v0.18.0-beta` | `9baa99a` | `FROM ghcr.io/ohdsi/trexsql:sha-2988da6c6509099c71c3346160be3d4f575f5712@sha256:…` → `2988da6` | 53 |
| `v0.17.1-beta` | `0.1.0-20260707025242-3a0f3f3` → `3a0f3f3` | `754542f` | 0 — below floor |
| `v0.16.0-beta` | **absent** | no trexsql image pin at all (`ENV TREXSQL_EXT_VERSION=0.2.3`) | 0 — below floor |

Consequences:

- **Three trex pin shapes**, not two: an `ARG TREXSQL_REF=` whose value may carry a target prefix
  (`prod-sha-…@sha256:…`), a hardcoded `FROM …trexsql:sha-…@sha256:…`, and the v0.16 shape where
  neither exists.
- **`v0.18.0-beta` carries both pins and the docs site**, so the spec's open question is resolved:
  the supported set is the full three — `develop`, `v0.18.1-beta`, `v0.18.0-beta`.
- Both pins must be recoverable from the repo's own files, so the extractor reads *file contents*
  and never needs git.

## Scope boundary

Phase D builds the **machinery** and the **tier-2 (docs) content** for the two release snapshots —
deterministic, no LLM, no API spend. Tier-3 generated knowledge bases per snapshot are **phase E**
(it owns multi-repo generation), and the scheduled refresh/new-release workflows are **phase F**.
A snapshot built by D therefore contains `docs/`, `troubleshooting.md` and `manifest.json`; the
point of D is that the version axis, the registry and the routing are real and tested.

Two further notes:

- Phase C emitted `troubleshooting.md`, not the spec's proposed `troubleshooting.json`, so the
  retrieval tools (`read_kb_file`, `grep_kb`) can read it. D keeps that.
- Per-channel/per-user default snapshots are part of the spec's version resolution, but the
  `/ask-admin` command was deliberately removed from this repo. D implements the resolution
  function so those defaults are representable (and tested), and passes `undefined` for them at
  the call sites; an admin surface to set them is not in D.

## Global Constraints

- Node >=20, TypeScript ^5.5, ESM (`"type": "module"`), NodeNext resolution. Every intra-repo import
  uses the `.js`-suffix-on-`.ts`-source convention.
- **No new dependencies**, runtime or dev. Tests use `node:test` / `node:assert/strict` only, run
  via `tsx --test`.
- **Pin extraction failure aborts the build and leaves `snapshots.json` untouched.** A snapshot
  built from mismatched refs is worse than no snapshot because its answers look authoritative.
- **Release snapshots are immutable**; only `develop` is refreshed. The registry holds at most
  `develop` + the two most recent releases as `active`.
- **Never silently answer from a different version.** An unsupported request is named as
  unsupported, the supported set is listed, and the answer carries an explicit caveat.
- The bot never writes to `curated/`. Phase D writes only under `snapshots/` and `snapshots.json`.
- Files stay focused: 200–400 lines typical, 800 hard maximum. Functions under 50 lines.
- No mutation of inputs. Functions return new objects rather than modifying arguments.
- All paths crossing a trust boundary are validated before any filesystem access.

## File Structure

| File | Responsibility |
|---|---|
| `src/kb/pins.ts` | Extract the atlas3 and trex pins a D2E checkout declares, or throw |
| `src/kb/pins.test.ts` | The above, against fixtures captured verbatim from real tags |
| `src/kb/snapshots.ts` | Snapshot registry types, load/save/validate, supported-set selection |
| `src/kb/snapshots.test.ts` | The above |
| `src/kb/buildSnapshot.ts` | Orchestrate one snapshot build: pins → docs tier → registry |
| `src/kb/buildSnapshot.test.ts` | The above, including the pin-failure-leaves-registry rule |
| `src/kb/buildSnapshotCli.ts` | CLI used by the (phase F) release workflow and by task 6 |
| `src/kb/versionRouting.ts` | Inline override parsing and snapshot resolution |
| `src/kb/versionRouting.test.ts` | The above |
| `api/_lib/answer.ts` | *(modify)* resolve the snapshot per question; carry the caveat |
| `api/_lib/answer.test.ts` | *(modify)* routing and caveat tests |
| `package.json` | *(modify)* add the `kb-build-snapshot` script |
| `snapshots.json` | *(in `ask-d2e-kb`)* the registry itself |

---

## Task list overview

| # | Task |
|---|---|
| 1 | Pin extractor, against the real tags |
| 2 | Snapshot registry: types, I/O, supported set |
| 3 | Snapshot build orchestration and CLI |
| 4 | Version routing: override parsing and resolution |
| 5 | Route questions through the resolver, with the unsupported-version caveat |
| 6 | Build the two real release snapshots and register them |

---

## Task 1: Pin extractor, against the real tags

**Files:**
- Create: `src/kb/pins.ts`
- Test: `src/kb/pins.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface D2ePins { atlas3: string; trex: string }`
  - `interface PinSources { atlasPackageJson: string; trexDockerfile: string }`
  - `function extractAtlas3Pin(packageJson: string): string`
  - `function extractTrexPin(dockerfile: string): string`
  - `function extractPins(sources: PinSources): D2ePins`

**Context:** The extractor reads file *contents*, so it is testable without git and usable from any
checkout. It must accept all three trex shapes and the one atlas shape, and throw with a message
naming the file when a pin is missing — this is the input to the "fail loudly" rule, so every
failure mode gets a test.

The short forms returned are the 7-character commit prefixes used everywhere else in the KB
(`snapshots.json` pins, citation paths).

- [ ] **Step 1: Write the failing test**

Create `src/kb/pins.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAtlas3Pin, extractTrexPin, extractPins } from "./pins.js";

// Captured verbatim from the real tags on 2026-09-11.
const ATLAS_DEVELOP = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260823112941-269a00a" } });
const ATLAS_V0181 = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260817035540-9baa99a" } });
const ATLAS_V0171 = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260707025242-3a0f3f3" } });
const ATLAS_NO_PIN = JSON.stringify({ dependencies: { react: "^18.0.0" } });

const TREX_DEVELOP = [
  "FROM ghcr.io/ohdsi/trexsql:${TREXSQL_REF} AS base",
  "ARG TREXSQL_REF=prod-sha-5ce42757279f969bca123f0128a5c967ff2e3bd4@sha256:e162d8282df32231b58297fd31fef8567272468c86a82c64d36ec76d0de0d6ca",
].join("\n");

const TREX_V0181 = [
  "FROM ghcr.io/ohdsi/trexsql:sha-dec4a9508dcc57597c64422d6a27a36daaf74e27@sha256:d7922fb4fa63aa3e74e5341df17552e5bd32d0b0af86882172528c9f9b5be9d9 AS base",
].join("\n");

const TREX_V016 = ["ENV TREXSQL_EXT_VERSION=0.2.3", "ENV TREXAS_PORT=9876"].join("\n");

test("extractAtlas3Pin reads the short commit from the version suffix", () => {
  assert.equal(extractAtlas3Pin(ATLAS_DEVELOP), "269a00a");
  assert.equal(extractAtlas3Pin(ATLAS_V0181), "9baa99a");
  assert.equal(extractAtlas3Pin(ATLAS_V0171), "3a0f3f3");
});

test("extractAtlas3Pin throws, naming the package, when the pin is absent", () => {
  assert.throws(() => extractAtlas3Pin(ATLAS_NO_PIN), /@ohdsi\/atlas3/);
});

test("extractAtlas3Pin throws on unparseable JSON rather than guessing", () => {
  assert.throws(() => extractAtlas3Pin("{ not json"), /parse/i);
});

test("extractAtlas3Pin throws on an unrecognised version format", () => {
  const raw = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "latest" } });
  assert.throws(() => extractAtlas3Pin(raw), /unrecognised/i);
});

test("extractTrexPin reads the ARG form, including a target prefix", () => {
  assert.equal(extractTrexPin(TREX_DEVELOP), "5ce4275");
});

test("extractTrexPin reads the hardcoded FROM form", () => {
  assert.equal(extractTrexPin(TREX_V0181), "dec4a95");
});

test("extractTrexPin prefers the ARG when both forms are present", () => {
  const both = [TREX_DEVELOP, TREX_V0181].join("\n");
  assert.equal(extractTrexPin(both), "5ce4275");
});

test("extractTrexPin throws when the file pins no trexsql image at all", () => {
  assert.throws(() => extractTrexPin(TREX_V016), /trexsql/i);
});

test("extractPins returns both pins", () => {
  assert.deepEqual(extractPins({ atlasPackageJson: ATLAS_V0181, trexDockerfile: TREX_V0181 }), {
    atlas3: "9baa99a",
    trex: "dec4a95",
  });
});

test("extractPins propagates a failure rather than returning a partial pair", () => {
  assert.throws(() => extractPins({ atlasPackageJson: ATLAS_NO_PIN, trexDockerfile: TREX_V0181 }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/pins.test.ts`
Expected: FAIL — `Cannot find module './pins.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/pins.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/pins.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Verify against the real tags, not just the fixtures**

```bash
node --import tsx --input-type=module -e '
import { execFileSync } from "node:child_process";
import { extractPins } from "./src/kb/pins.ts";
const repo = "../upstream/Data2Evidence";
const read = (ref, path) => execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
for (const ref of ["develop", "v0.18.1-beta", "v0.17.1-beta"]) {
  const pins = extractPins({
    atlasPackageJson: read(ref, "plugins/atlas/package.json"),
    trexDockerfile: read(ref, "services/trex/Dockerfile.v2"),
  });
  console.log(ref, JSON.stringify(pins));
}
try {
  extractPins({
    atlasPackageJson: read("v0.16.0-beta", "plugins/atlas/package.json"),
    trexDockerfile: read("v0.16.0-beta", "services/trex/Dockerfile.v2"),
  });
  console.log("v0.16.0-beta: UNEXPECTEDLY SUCCEEDED");
} catch (err) {
  console.log("v0.16.0-beta fails cleanly:", err.message);
}
'
```

Expected: `develop {"atlas3":"269a00a","trex":"5ce4275"}`, `v0.18.1-beta {"atlas3":"9baa99a","trex":"dec4a95"}`, `v0.17.1-beta {"atlas3":"3a0f3f3","trex":"754542f"}`, then a clean failure for `v0.16.0-beta`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/pins.ts src/kb/pins.test.ts
git commit -m "feat(kb): extract D2E dependency pins from a release checkout"
```

---

## Task 2: Snapshot registry — types, I/O, supported set

**Files:**
- Create: `src/kb/snapshots.ts`
- Test: `src/kb/snapshots.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type SnapshotStatus = "active" | "retired" | "building"`
  - `interface SnapshotEntry { id: string; d2eTag: string; pins: { atlas3: string; trex: string }; status: SnapshotStatus; builtAt: string; isDevelop: boolean }`
  - `interface SnapshotRegistry { snapshots: SnapshotEntry[] }`
  - `const MAX_ACTIVE_RELEASES = 2`
  - `function emptyRegistry(): SnapshotRegistry`
  - `function parseSnapshotRegistry(raw: string): SnapshotRegistry`
  - `function loadSnapshotRegistry(kbRoot: string): SnapshotRegistry`
  - `function writeSnapshotRegistry(kbRoot: string, registry: SnapshotRegistry): void`
  - `function supportedSnapshotIds(registry: SnapshotRegistry): string[]`
  - `function registerSnapshot(registry: SnapshotRegistry, entry: SnapshotEntry): SnapshotRegistry`

**Context:** `snapshots.json` is the source of truth for which versions exist and which are
supported. Loading is tolerant of a missing file (phases A–C shipped without one) but strict about
a malformed one — a registry that silently dropped entries would make the bot answer from the
wrong version. Registration enforces the spec's "`develop` plus the two most recent releases" rule
by retiring older releases rather than deleting them.

- [ ] **Step 1: Write the failing test**

Create `src/kb/snapshots.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ACTIVE_RELEASES,
  emptyRegistry,
  parseSnapshotRegistry,
  loadSnapshotRegistry,
  writeSnapshotRegistry,
  supportedSnapshotIds,
  registerSnapshot,
  type SnapshotEntry,
} from "./snapshots.js";

function entry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: "v0.18.1-beta",
    d2eTag: "v0.18.1-beta",
    pins: { atlas3: "9baa99a", trex: "dec4a95" },
    status: "active",
    builtAt: "2026-09-11T00:00:00.000Z",
    isDevelop: false,
    ...overrides,
  };
}

test("parseSnapshotRegistry round-trips a registry", () => {
  const registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  assert.deepEqual(parseSnapshotRegistry(JSON.stringify(registry)), registry);
});

test("parseSnapshotRegistry throws on an entry missing required fields", () => {
  assert.throws(() => parseSnapshotRegistry(JSON.stringify({ snapshots: [{ id: "x" }] })), /pins/i);
});

test("parseSnapshotRegistry throws on an unknown status", () => {
  const raw = JSON.stringify({ snapshots: [entry({ status: "zombie" as never })] });
  assert.throws(() => parseSnapshotRegistry(raw), /status/i);
});

test("loadSnapshotRegistry returns an empty registry when the file is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-empty-"));
  assert.deepEqual(loadSnapshotRegistry(root), emptyRegistry());
});

test("writeSnapshotRegistry then loadSnapshotRegistry round-trips through disk", () => {
  const root = mkdtempSync(join(tmpdir(), "snap-io-"));
  const registry = { snapshots: [entry()] };
  writeSnapshotRegistry(root, registry);
  assert.deepEqual(loadSnapshotRegistry(root), registry);
  assert.match(readFileSync(join(root, "snapshots.json"), "utf8"), /v0\.18\.1-beta/);
});

test("supportedSnapshotIds lists develop first, then releases newest first", () => {
  const registry = {
    snapshots: [
      entry({ id: "v0.18.0-beta", d2eTag: "v0.18.0-beta" }),
      entry({ id: "develop", d2eTag: "develop", isDevelop: true }),
      entry({ id: "v0.18.1-beta", d2eTag: "v0.18.1-beta" }),
      entry({ id: "v0.17.1-beta", d2eTag: "v0.17.1-beta", status: "retired" }),
    ],
  };
  assert.deepEqual(supportedSnapshotIds(registry), ["develop", "v0.18.1-beta", "v0.18.0-beta"]);
});

test("registerSnapshot adds an entry without mutating the input registry", () => {
  const before = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  const after = registerSnapshot(before, entry());
  assert.equal(before.snapshots.length, 1);
  assert.deepEqual(supportedSnapshotIds(after), ["develop", "v0.18.1-beta"]);
});

test("registerSnapshot replaces an entry with the same id", () => {
  const before = { snapshots: [entry({ pins: { atlas3: "old", trex: "old" } })] };
  const after = registerSnapshot(before, entry());
  assert.equal(after.snapshots.length, 1);
  assert.deepEqual(after.snapshots[0].pins, { atlas3: "9baa99a", trex: "dec4a95" });
});

test("registerSnapshot retires releases beyond the two most recent", () => {
  let registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  for (const id of ["v0.17.1-beta", "v0.18.0-beta", "v0.18.1-beta"]) {
    registry = registerSnapshot(registry, entry({ id, d2eTag: id }));
  }
  assert.deepEqual(supportedSnapshotIds(registry), ["develop", "v0.18.1-beta", "v0.18.0-beta"]);
  const retired = registry.snapshots.filter((s) => s.status === "retired").map((s) => s.id);
  assert.deepEqual(retired, ["v0.17.1-beta"]);
  assert.equal(
    registry.snapshots.filter((s) => s.status === "active" && !s.isDevelop).length,
    MAX_ACTIVE_RELEASES,
  );
});

test("registerSnapshot never retires develop", () => {
  let registry = { snapshots: [entry({ id: "develop", d2eTag: "develop", isDevelop: true })] };
  for (const id of ["v0.18.0-beta", "v0.18.1-beta", "v0.19.0-beta"]) {
    registry = registerSnapshot(registry, entry({ id, d2eTag: id }));
  }
  assert.equal(registry.snapshots.find((s) => s.isDevelop)?.status, "active");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/snapshots.test.ts`
Expected: FAIL — `Cannot find module './snapshots.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/snapshots.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/snapshots.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/snapshots.ts src/kb/snapshots.test.ts
git commit -m "feat(kb): snapshot registry with the supported-version set"
```

---

## Task 3: Snapshot build orchestration and CLI

**Files:**
- Create: `src/kb/buildSnapshot.ts`, `src/kb/buildSnapshotCli.ts`
- Test: `src/kb/buildSnapshot.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `extractPins` from `./pins.js`; `buildDocsTier` from `./buildDocsTier.js`; the registry functions from `./snapshots.js`
- Produces:
  - `interface PinSourceBundle { atlasPackageJson: string; trexDockerfile: string; docsRoot: string }`
  - `interface SnapshotBuildInput` — `PinSourceBundle` plus `{ kbRoot: string; snapshotId: string; d2eTag: string; isDevelop: boolean; builtAt?: string }`
  - `interface SnapshotBuildResult { entry: SnapshotEntry; docsWritten: number; troubleshootingEntries: number; manifestEntries: number }`
  - `const PIN_SOURCE_PATHS: { atlasPackageJson: string; trexDockerfile: string; docsRoot: string }`
  - `function readPinSources(d2eRoot: string): PinSourceBundle`
  - `function buildSnapshot(input: SnapshotBuildInput): SnapshotBuildResult`

**Context:** This is where the spec's error-handling rule is enforced: **pin extraction happens
before any write**, so a checkout that declares no pins aborts the build with `snapshots.json`
byte-identical and no `snapshots/<id>/` directory created. The build order is pins → docs tier →
registry, and the tests prove the ordering rather than trusting it.

- [ ] **Step 1: Write the failing test**

Create `src/kb/buildSnapshot.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, readPinSources } from "./buildSnapshot.js";
import { loadSnapshotRegistry, writeSnapshotRegistry } from "./snapshots.js";

const ATLAS = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260817035540-9baa99a" } });
const TREX =
  "FROM ghcr.io/ohdsi/trexsql:sha-dec4a9508dcc57597c64422d6a27a36daaf74e27@sha256:d7922fb4 AS base";

function makeD2eCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "d2e-checkout-"));
  mkdirSync(join(root, "plugins", "atlas"), { recursive: true });
  mkdirSync(join(root, "services", "trex"), { recursive: true });
  mkdirSync(join(root, "docs", "website", "docs", "2-admin_guide"), { recursive: true });
  writeFileSync(join(root, "plugins", "atlas", "package.json"), ATLAS);
  writeFileSync(join(root, "services", "trex", "Dockerfile.v2"), TREX);
  writeFileSync(
    join(root, "docs", "website", "docs", "2-admin_guide", "cli.md"),
    [
      "# CLI",
      "",
      "Run ./d2e up.",
      "",
      "## Troubleshooting",
      "",
      "### Port in use",
      "",
      "**Resolution:** Stop it.",
    ].join("\n"),
  );
  return root;
}

test("readPinSources reads both pin files and the docs root from a checkout", () => {
  const checkout = makeD2eCheckout();
  const sources = readPinSources(checkout);
  assert.match(sources.atlasPackageJson, /@ohdsi\/atlas3/);
  assert.match(sources.trexDockerfile, /trexsql/);
  assert.equal(sources.docsRoot, join(checkout, "docs", "website", "docs"));
});

test("buildSnapshot writes the docs tier and registers the snapshot", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-snap-"));
  const checkout = makeD2eCheckout();

  const result = buildSnapshot({
    kbRoot,
    snapshotId: "v0.18.1-beta",
    d2eTag: "v0.18.1-beta",
    isDevelop: false,
    builtAt: "2026-09-11T00:00:00.000Z",
    ...readPinSources(checkout),
  });

  assert.deepEqual(result.entry.pins, { atlas3: "9baa99a", trex: "dec4a95" });
  assert.equal(result.docsWritten, 1);
  assert.equal(result.troubleshootingEntries, 1);
  assert.ok(existsSync(join(kbRoot, "snapshots", "v0.18.1-beta", "manifest.json")));
  assert.deepEqual(loadSnapshotRegistry(kbRoot).snapshots.map((s) => s.id), ["v0.18.1-beta"]);
});

test("a missing pin aborts before any write, leaving snapshots.json untouched", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-nopin-"));
  writeSnapshotRegistry(kbRoot, {
    snapshots: [
      {
        id: "develop",
        d2eTag: "develop",
        pins: { atlas3: "269a00a", trex: "5ce4275" },
        status: "active",
        builtAt: "2026-09-11T00:00:00.000Z",
        isDevelop: true,
      },
    ],
  });
  const before = readFileSync(join(kbRoot, "snapshots.json"), "utf8");
  const checkout = makeD2eCheckout();

  assert.throws(() =>
    buildSnapshot({
      kbRoot,
      snapshotId: "v0.16.0-beta",
      d2eTag: "v0.16.0-beta",
      isDevelop: false,
      atlasPackageJson: JSON.stringify({ dependencies: { react: "^18" } }),
      trexDockerfile: TREX,
      docsRoot: join(checkout, "docs", "website", "docs"),
    }),
  );

  assert.equal(readFileSync(join(kbRoot, "snapshots.json"), "utf8"), before);
  assert.equal(existsSync(join(kbRoot, "snapshots", "v0.16.0-beta")), false);
});

test("a checkout with no docs aborts rather than registering an empty snapshot", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-nodocs-"));
  assert.throws(
    () =>
      buildSnapshot({
        kbRoot,
        snapshotId: "v0.18.1-beta",
        d2eTag: "v0.18.1-beta",
        isDevelop: false,
        atlasPackageJson: ATLAS,
        trexDockerfile: TREX,
        docsRoot: join(tmpdir(), "definitely-not-here-54321"),
      }),
    /no documentation/i,
  );
  assert.equal(existsSync(join(kbRoot, "snapshots.json")), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/buildSnapshot.test.ts`
Expected: FAIL — `Cannot find module './buildSnapshot.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/buildSnapshot.ts`:

```typescript
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
```

Create `src/kb/buildSnapshotCli.ts`:

```typescript
import { buildSnapshot, readPinSources } from "./buildSnapshot.js";
import { required, optional } from "../shared/config.js";

const d2eRoot = required("D2E_ROOT");
const snapshotId = required("SNAPSHOT_ID");

const result = buildSnapshot({
  kbRoot: required("KB_ROOT"),
  snapshotId,
  d2eTag: optional("D2E_TAG", snapshotId),
  isDevelop: optional("IS_DEVELOP", "false") === "true",
  ...readPinSources(d2eRoot),
});

console.log(
  `Snapshot ${result.entry.id} (${result.entry.d2eTag}) pins atlas3=${result.entry.pins.atlas3} ` +
    `trex=${result.entry.pins.trex}`,
);
console.log(
  `Wrote ${result.docsWritten} docs, ${result.troubleshootingEntries} troubleshooting entries, ` +
    `${result.manifestEntries} manifest entries`,
);
```

Add to `package.json` `"scripts"`:

```json
    "kb-build-snapshot": "tsx src/kb/buildSnapshotCli.ts",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/buildSnapshot.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:api
git add src/kb/buildSnapshot.ts src/kb/buildSnapshot.test.ts src/kb/buildSnapshotCli.ts package.json
git commit -m "feat(kb): build and register a snapshot from a release checkout"
```

---

## Task 4: Version routing — override parsing and resolution

**Files:**
- Create: `src/kb/versionRouting.ts`
- Test: `src/kb/versionRouting.test.ts`

**Interfaces:**
- Consumes: `supportedSnapshotIds` from `./snapshots.js`
- Produces:
  - `interface SnapshotOverride { requested: string | null; question: string }`
  - `function parseSnapshotOverride(question: string): SnapshotOverride`
  - `interface VersionResolution { snapshotId: string; requested: string | null; supported: string[]; unsupported: boolean; caveat: string | null }`
  - `function resolveSnapshot(args: { requested: string | null; defaultId?: string; registry: SnapshotRegistry }): VersionResolution`

**Context:** Two jobs. Parsing pulls a leading version token off the question (`/ask v0.18.1 why
does X fail`) so it never reaches the model. Resolution picks a snapshot: an exact or prefix match
against the supported set wins, otherwise the supplied default (channel/user) applies, and
otherwise `develop`. A request for an unsupported release resolves to the **oldest supported
release** — the nearest answer to the only realistic case, a partner below the floor — and always
carries a caveat naming the supported set. Silently answering from a different version is the
failure this module exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `src/kb/versionRouting.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotOverride, resolveSnapshot } from "./versionRouting.js";
import type { SnapshotEntry, SnapshotRegistry } from "./snapshots.js";

function entry(id: string, isDevelop = false): SnapshotEntry {
  return {
    id,
    d2eTag: id,
    pins: { atlas3: "9baa99a", trex: "dec4a95" },
    status: "active",
    builtAt: "2026-09-11T00:00:00.000Z",
    isDevelop,
  };
}

const REGISTRY: SnapshotRegistry = {
  snapshots: [entry("develop", true), entry("v0.18.1-beta"), entry("v0.18.0-beta")],
};

test("parseSnapshotOverride strips a leading version token", () => {
  assert.deepEqual(parseSnapshotOverride("v0.18.1 why does the stack fail?"), {
    requested: "v0.18.1",
    question: "why does the stack fail?",
  });
});

test("parseSnapshotOverride strips a leading develop token", () => {
  assert.deepEqual(parseSnapshotOverride("develop how do I start?"), {
    requested: "develop",
    question: "how do I start?",
  });
});

test("parseSnapshotOverride leaves an ordinary question alone", () => {
  const q = "why does v0.18.1 fail to start?";
  assert.deepEqual(parseSnapshotOverride(q), { requested: null, question: q });
});

test("resolveSnapshot defaults to develop with no request", () => {
  const resolution = resolveSnapshot({ requested: null, registry: REGISTRY });
  assert.equal(resolution.snapshotId, "develop");
  assert.equal(resolution.unsupported, false);
  assert.equal(resolution.caveat, null);
});

test("resolveSnapshot honours an exact request", () => {
  const resolution = resolveSnapshot({ requested: "v0.18.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "v0.18.1-beta");
  assert.equal(resolution.unsupported, false);
});

test("resolveSnapshot matches a partial version to the newest snapshot that fits", () => {
  assert.equal(resolveSnapshot({ requested: "v0.18.1", registry: REGISTRY }).snapshotId, "v0.18.1-beta");
  assert.equal(resolveSnapshot({ requested: "v0.18.0", registry: REGISTRY }).snapshotId, "v0.18.0-beta");
});

test("resolveSnapshot prefers the supplied default over develop", () => {
  const resolution = resolveSnapshot({ requested: null, defaultId: "v0.18.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "v0.18.1-beta");
});

test("resolveSnapshot ignores a default that is not supported", () => {
  const resolution = resolveSnapshot({ requested: null, defaultId: "v0.17.1-beta", registry: REGISTRY });
  assert.equal(resolution.snapshotId, "develop");
});

test("an unsupported request resolves to the oldest supported release with a caveat", () => {
  const resolution = resolveSnapshot({ requested: "v0.17", registry: REGISTRY });
  assert.equal(resolution.unsupported, true);
  assert.equal(resolution.snapshotId, "v0.18.0-beta");
  assert.match(resolution.caveat ?? "", /outside the supported range/);
  assert.match(resolution.caveat ?? "", /develop, v0\.18\.1-beta, v0\.18\.0-beta/);
  assert.match(resolution.caveat ?? "", /v0\.17/);
});

test("an empty registry still resolves to develop rather than failing", () => {
  const resolution = resolveSnapshot({ requested: "v0.18.1", registry: { snapshots: [] } });
  assert.equal(resolution.snapshotId, "develop");
  assert.equal(resolution.unsupported, true);
  assert.match(resolution.caveat ?? "", /develop/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/versionRouting.test.ts`
Expected: FAIL — `Cannot find module './versionRouting.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/versionRouting.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/versionRouting.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/versionRouting.ts src/kb/versionRouting.test.ts
git commit -m "feat(kb): route questions to a snapshot with an unsupported-version caveat"
```

---

## Task 5: Route questions through the resolver, with the caveat

**Files:**
- Modify: `api/_lib/answer.ts`
- Modify: `api/_lib/answer.test.ts`

**Interfaces:**
- Consumes: `parseSnapshotOverride`, `resolveSnapshot` from `../../src/kb/versionRouting.js`; `loadSnapshotRegistry` from `../../src/kb/snapshots.js`
- Produces: no new exports — `answerQuestion`'s existing `snapshotId` parameter becomes the *default* snapshot, and everything else about its signature is unchanged

**Context:** Resolution belongs inside `answerQuestion` so every entry point (`/ask`, @mention,
DMs, thread follow-ups — all of which now funnel through `answerFlow.ts`) gets it without changes
at each call site. The `snapshotId` parameter keeps its meaning as the caller-supplied default;
the inline override in the question text wins over it.

When the resolution is unsupported, the caveat is prefixed to the answer. The answer still comes
from the nearest supported snapshot — the spec's "offer the nearest supported answer with an
explicit caveat", never a silent substitution.

- [ ] **Step 1: Write the failing test**

Append to `api/_lib/answer.test.ts`:

```typescript
import { writeFileSync as writeSnapshots } from "node:fs";

function rootWithSnapshots(): string {
  const root = mkdtemp2(join(tmpdir(), "answer-snapshots-"));
  writeSnapshots(
    join(root, "snapshots.json"),
    JSON.stringify({
      snapshots: [
        { id: "develop", d2eTag: "develop", pins: { atlas3: "269a00a", trex: "5ce4275" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: true },
        { id: "v0.18.1-beta", d2eTag: "v0.18.1-beta", pins: { atlas3: "9baa99a", trex: "dec4a95" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: false },
        { id: "v0.18.0-beta", d2eTag: "v0.18.0-beta", pins: { atlas3: "9baa99a", trex: "2988da6" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: false },
      ],
    }),
  );
  return root;
}

async function systemPromptFor(question: string, root: string): Promise<{ system: string; question: string }> {
  let system = "";
  let asked = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[]; messages: { content: unknown }[] };
        if (!system) {
          system = body.system.map((s) => s.text).join("\n");
          asked = String(body.messages[body.messages.length - 1].content);
        }
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = root;
  try {
    await answerQuestionRetrieval(question, [], client);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
  return { system, question: asked };
}

test("an inline version override routes to that snapshot and is stripped from the question", async () => {
  const { system, question } = await systemPromptFor("v0.18.1 how do I start?", rootWithSnapshots());
  assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.1-beta\)/);
  assert.equal(question, "how do I start?");
});

test("a question with no override uses develop", async () => {
  const { system } = await systemPromptFor("how do I start?", rootWithSnapshots());
  assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: develop\)/);
});

test("an unsupported version is answered from the nearest release with an explicit caveat", async () => {
  const root = rootWithSnapshots();
  let system = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        system = (args[0] as { system: { text: string }[] }).system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "The CLI lives in d2e/." }], stop_reason: "end_turn" };
      },
    },
  };
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = root;
  try {
    const result = await answerQuestionRetrieval("v0.17 why does the CLI fail?", [], client);
    assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.0-beta\)/);
    assert.match(result.text, /outside the supported range/);
    assert.match(result.text, /v0\.17/);
    assert.match(result.text, /The CLI lives in d2e/);
    assert.equal(result.covered, true);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test api/_lib/answer.test.ts`
Expected: FAIL — the system prompt still always says `develop`, and no caveat is emitted.

- [ ] **Step 3: Wire the resolver in**

In `api/_lib/answer.ts`, add:

```typescript
import { loadSnapshotRegistry } from "../../src/kb/snapshots.js";
import { parseSnapshotOverride, resolveSnapshot } from "../../src/kb/versionRouting.js";
```

and replace the top of `answerQuestion`'s body up to the `runRetrievalLoop` call with:

```typescript
  const usingOauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const anthropic = client ?? (makeClient() as unknown as AnthropicLikeClient);
  const root = kbRoot();

  const parsed = parseSnapshotOverride(question);
  const resolution = resolveSnapshot({
    requested: parsed.requested,
    defaultId: snapshotId,
    registry: loadSnapshotRegistry(root),
  });

  const system = [
    ...(usingOauth ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }] : []),
    { type: "text" as const, text: INSTRUCTIONS },
    { type: "text" as const, text: faqText(root) },
    {
      type: "text" as const,
      text: loadManifestText(root, resolution.snapshotId),
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const messages = [
    ...history.map((t) => ({ role: t.role as string, content: t.text as unknown })),
    { role: "user", content: parsed.question as unknown },
  ];
```

change the loop's `scope` to `scopeForSnapshot(root, resolution.snapshotId)`, and change the return
to prefix the caveat when there is one:

```typescript
  const body = covered
    ? outcome.text
    : (outcome.text.slice(0, match.index) + outcome.text.slice(match.index! + match[0].length)).replace(/^\s+/, "");
  const text = resolution.caveat ? `${resolution.caveat}\n\n${body}` : body;

  return { text, covered, filesRead: outcome.filesRead, truncated: outcome.truncated };
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm run typecheck:api && npm test`
Expected: PASS. Every pre-existing answer test keeps passing because a missing `snapshots.json`
resolves to `develop`, exactly as before.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/answer.ts api/_lib/answer.test.ts
git commit -m "feat(api): resolve each question to a snapshot and caveat unsupported versions"
```

---

## Task 6: Build the two real release snapshots and register them

**Files:**
- Create (in `ask-d2e-kb`): `snapshots.json`, `snapshots/v0.18.1-beta/**`, `snapshots/v0.18.0-beta/**`
- Modify (in `ask-d2e-kb`): `snapshots/develop/manifest.json` (only `generatedAt` should change)

**Context:** The proofs for phase D. `develop` is re-registered from the existing checkout;
the two release snapshots are cloned at their tags. This is also the check that snapshot building
is deterministic: rebuilding `develop` must reproduce the committed docs byte-for-byte apart from
`generatedAt`.

- [ ] **Step 1: Re-register develop from the existing checkout**

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon/ask-d2e
D2E_ROOT="$(cd ../upstream/Data2Evidence && pwd)" \
KB_ROOT="$(cd ../ask-d2e-kb && pwd)" \
SNAPSHOT_ID=develop D2E_TAG=develop IS_DEVELOP=true \
npm run kb-build-snapshot
```

Expected: `Snapshot develop (develop) pins atlas3=269a00a trex=5ce4275`, `Wrote 53 docs, 7 troubleshooting entries, 54 manifest entries`, and `git -C ../ask-d2e-kb status --short` showing only `snapshots.json` plus (if the clock moved) `snapshots/develop/manifest.json`.

- [ ] **Step 2: Build both release snapshots from their tags**

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon/ask-d2e
for TAG in v0.18.1-beta v0.18.0-beta; do
  DIR=$(mktemp -d "/tmp/d2e-${TAG}.XXXXXX")
  git clone -q --depth 1 --branch "$TAG" https://github.com/OHDSI/Data2Evidence.git "$DIR"
  D2E_ROOT="$DIR" KB_ROOT="$(cd ../ask-d2e-kb && pwd)" SNAPSHOT_ID="$TAG" D2E_TAG="$TAG" IS_DEVELOP=false \
    npm run kb-build-snapshot
done
```

Expected, in order:

```
Snapshot v0.18.1-beta (v0.18.1-beta) pins atlas3=9baa99a trex=dec4a95
Wrote 53 docs, 7 troubleshooting entries, 54 manifest entries
Snapshot v0.18.0-beta (v0.18.0-beta) pins atlas3=9baa99a trex=2988da6
Wrote 53 docs, ... manifest entries
```

- [ ] **Step 3: Prove the retrieval path reads a release snapshot**

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon/ask-d2e
KB_ROOT="$(cd ../ask-d2e-kb && pwd)" node --import tsx --input-type=module -e '
import { scopeForSnapshot } from "./src/kb/kbScope.ts";
import { executeKbTool } from "./api/_lib/kbTools.ts";
for (const id of ["develop", "v0.18.1-beta", "v0.18.0-beta"]) {
  const hit = executeKbTool("grep_kb", { pattern: "illegal hardware instruction" }, scopeForSnapshot(process.env.KB_ROOT, id));
  console.log(id, hit.isError ? `ERROR ${hit.content}` : hit.content.split("\n")[0]);
}
'
```

Expected: one `snapshots/<id>/docs/…cli.md` line per snapshot, no errors.

- [ ] **Step 4: Confirm the registry and scoping rules hold**

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon/ask-d2e
node --import tsx --input-type=module -e '
import { loadSnapshotRegistry, supportedSnapshotIds } from "./src/kb/snapshots.ts";
import { resolveSnapshot } from "./src/kb/versionRouting.ts";
const registry = loadSnapshotRegistry("../ask-d2e-kb");
console.log("supported:", supportedSnapshotIds(registry));
console.log("pins:", registry.snapshots.map((s) => `${s.id}=${s.pins.atlas3}/${s.pins.trex}`).join(" "));
console.log("v0.17 ->", resolveSnapshot({ requested: "v0.17", registry }));
'
```

Expected: `supported: [ 'develop', 'v0.18.1-beta', 'v0.18.0-beta' ]`, the three pin pairs, and a `v0.17` resolution marked `unsupported: true` pointing at `v0.18.0-beta`.

- [ ] **Step 5: Run the whole suite and commit both repos**

```bash
npm run typecheck && npm run typecheck:api && npm test
git -C ../ask-d2e-kb add snapshots.json snapshots/
git -C ../ask-d2e-kb commit -m "docs(kb): register develop, v0.18.1-beta and v0.18.0-beta snapshots"
```

---

## Done criteria

- [ ] `npm run typecheck && npm run typecheck:api && npm test` passes.
- [ ] The pin extractor reproduces the real pins for `develop`, `v0.18.1-beta`, `v0.18.0-beta` and `v0.17.1-beta`, and fails cleanly on `v0.16.0-beta`.
- [ ] `snapshots.json` in `ask-d2e-kb` lists `develop`, `v0.18.1-beta` and `v0.18.0-beta` as `active`, with the pins from the table at the top of this plan.
- [ ] Each of those three snapshots has `docs/`, `troubleshooting.md` and `manifest.json`.
- [ ] `grep_kb` finds a real troubleshooting symptom inside each snapshot, including the two releases.
- [ ] An inline override (`v0.18.1 …`) routes the answer to that snapshot and is stripped from the question.
- [ ] An unsupported version (`v0.17 …`) answers from the nearest supported release and says so, naming the supported set.
- [ ] A pin-extraction failure leaves `snapshots.json` byte-identical and creates no snapshot directory.

## Follow-on work, explicitly not in this plan

- **E** — generated (tier-3) KBs per snapshot: D2E per release plus Atlas3, trex and the shared WebAPI contract.
- **F** — the release workflow (`kb-snapshot-build.yml`), the daily `develop` refresh, new-release detection and FAQ drift detection. `kb-refresh.yml` lands there, not here.
- **G** — the public web surface and its version picker, which defaults to the latest release rather than `develop`.
