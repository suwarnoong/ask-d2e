# Tiered KB Phases A–C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-KB prompt stuffing with bounded agentic file retrieval, then layer a human-authored curated FAQ and the D2E official documentation on top of it as higher-authority knowledge tiers.

**Architecture:** The answer engine stops rendering every KB byte into the system prompt. Instead each knowledge set emits a `manifest.json` index (path + title + one-line summary), and the model navigates the real files through three scoped, bounded tools (`read_kb_file`, `grep_kb`, `list_kb_dir`). On top of that retrieval core, two higher-authority tiers are added: tier 1 is a human-authored curated FAQ shipped whole in every prompt, and tier 2 is the Data2Evidence Docusaurus documentation extracted deterministically (no LLM rewriting) into KB markdown plus a symptom-keyed troubleshooting index.

**Tech Stack:** Node >=20, TypeScript 5.5, ESM (`"type": "module"`, NodeNext resolution), `tsx` to run TypeScript directly, Node's built-in `node:test` / `node:assert/strict` via `tsx --test`, `@anthropic-ai/sdk`. No new runtime or test dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-multi-repo-tiered-kb-design.md`

## Global Constraints

- Node >=20, TypeScript ^5.5, ESM (`"type": "module"`), NodeNext module resolution. Every intra-repo import uses the `.js`-suffix-on-`.ts`-source convention (e.g. `import { required } from "./config.js"` from a sibling `.ts` file).
- **No new dependencies**, runtime or dev. YAML frontmatter is parsed by a purpose-written restricted parser, not a YAML library. Tests use `node:test` / `node:assert/strict` only.
- Tests run via `npm test`, which globs `src`, `api` and `scripts` for `*.test.ts` and `*.test.mjs`.
- **Citations must be path-exact.** The answer engine emits, and the correction flow parses, exact repository-relative paths. Every citation shape the engine can emit must be resolvable by `resolveRepoFromCitation`.
- **The bot never writes to `curated/`.** Tier 1 is human-authored via PR only.
- **Tier 2 content reaches the answer unaltered.** Docs extraction is deterministic string transformation. No LLM rewrites documentation prose.
- Tier precedence, enforced in the prompt: tier 1 (curated FAQ) > tier 2 (official docs) > tier 3 (generated KB). Legal, licensing, pricing and support-model questions are answered from tier 1 only, or declined.
- Files stay focused: 200–400 lines typical, 800 hard maximum. Functions under 50 lines.
- No mutation of inputs. Functions return new objects rather than modifying arguments.
- All paths crossing a trust boundary are validated before any filesystem access.

## File Structure

**Phase A — retrieval core**

| File | Responsibility |
|---|---|
| `src/kb/manifest.ts` | Manifest types, title extraction, manifest construction and prompt rendering |
| `src/kb/manifest.test.ts` | Tests for the above |
| `src/kb/kbScope.ts` | Path scoping and traversal safety for retrieval reads |
| `src/kb/kbScope.test.ts` | Tests for the above |
| `api/_lib/kbTools.ts` | The three tool schemas and their executors |
| `api/_lib/kbTools.test.ts` | Tests for the above |
| `api/_lib/retrievalLoop.ts` | The bounded multi-turn tool loop |
| `api/_lib/retrievalLoop.test.ts` | Tests for the above |
| `src/shared/anthropicLike.ts` | *(modify)* widen the stub client type to carry tool-use blocks |
| `api/_lib/answer.ts` | *(modify)* rewire `answerQuestion` onto the retrieval loop |
| `src/kb/repoResolution.ts` | *(modify)* widen the citation parser to the new path shapes |

**Phase B — tier 1, curated FAQ**

| File | Responsibility |
|---|---|
| `src/kb/frontmatter.ts` | Restricted YAML-subset frontmatter parser |
| `src/kb/frontmatter.test.ts` | Tests for the above |
| `src/kb/faq.ts` | FAQ entry types, file parsing, loading, prompt rendering |
| `src/kb/faq.test.ts` | Tests for the above |
| `api/_lib/answer.ts` | *(modify)* ship the FAQ whole, add tier-precedence rules |

**Phase C — tier 2, official docs**

| File | Responsibility |
|---|---|
| `src/kb/docsExtract.ts` | Docusaurus markdown → KB markdown, deterministic |
| `src/kb/docsExtract.test.ts` | Tests for the above |
| `src/kb/troubleshooting.ts` | `## Troubleshooting` section parsing into a symptom index |
| `src/kb/troubleshooting.test.ts` | Tests for the above |
| `src/kb/buildDocsTier.ts` | Orchestrator: extract tree, write docs + index + manifest |
| `src/kb/buildDocsTier.test.ts` | Tests for the above |
| `package.json` | *(modify)* add the `kb-build-docs` script |

---

## Task list overview

| # | Task | Phase |
|---|---|---|
| 1 | Manifest types, title extraction and rendering | A |
| 2 | Path scoping and traversal safety | A |
| 3 | Widen the stub Anthropic client type | A |
| 4 | The three KB tools: schemas and executors | A |
| 5 | The bounded retrieval loop | A |
| 6 | Rewire `answerQuestion` onto the loop | A |
| 7 | Widen the citation parser, with a round-trip guard | A |
| 8 | Restricted frontmatter parser | B |
| 9 | FAQ types, parsing and loading | B |
| 10 | Author the 13 curated FAQ files | B |
| 11 | Ship the FAQ whole, with tier-precedence rules | B |
| 12 | Deterministic Docusaurus extraction | C |
| 13 | Troubleshooting section indexing | C |
| 14 | Docs-tier build orchestrator | C |

---

## Task 1: Manifest types, title extraction and rendering

**Files:**
- Create: `src/kb/manifest.ts`
- Test: `src/kb/manifest.test.ts`

**Interfaces:**
- Consumes: `KbFile` from `src/kb/kbFiles.ts` — `{ path: string; content: string }`
- Produces:
  - `interface ManifestEntry { path: string; title: string; summary: string }`
  - `interface KbManifest { snapshotId: string; generatedAt: string; entries: ManifestEntry[] }`
  - `function extractTitle(content: string): string`
  - `function buildManifest(snapshotId: string, files: KbFile[], summarize: (file: KbFile) => string): KbManifest`
  - `function renderManifest(manifest: KbManifest): string`

**Context:** The manifest is the only thing guaranteed to be in the system prompt on every request. It must be compact — one line per file — and it must give the model enough to decide what to read. `summarize` is injected rather than hardcoded so tests stay deterministic and the build step can supply an LLM-backed summariser later without changing this module.

- [ ] **Step 1: Write the failing test**

Create `src/kb/manifest.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTitle, buildManifest, renderManifest } from "./manifest.js";

test("extractTitle takes the first markdown heading", () => {
  assert.equal(extractTitle("# Cohort Studies\n\nSome prose."), "Cohort Studies");
  assert.equal(extractTitle("intro\n\n## Deep Dive\nmore"), "Deep Dive");
});

test("extractTitle falls back to a stable placeholder when there is no heading", () => {
  assert.equal(extractTitle("just prose, no heading"), "(untitled)");
  assert.equal(extractTitle(""), "(untitled)");
});

test("extractTitle trims trailing hashes and whitespace", () => {
  assert.equal(extractTitle("#   Spaced Out   ###"), "Spaced Out");
});

test("buildManifest records one entry per file, sorted by path", () => {
  const files = [
    { path: "b/second.md", content: "# Second" },
    { path: "a/first.md", content: "# First" },
  ];
  const manifest = buildManifest("develop", files, (f) => `summary of ${f.path}`);

  assert.equal(manifest.snapshotId, "develop");
  assert.deepEqual(
    manifest.entries.map((e) => e.path),
    ["a/first.md", "b/second.md"],
  );
  assert.deepEqual(manifest.entries[0], {
    path: "a/first.md",
    title: "First",
    summary: "summary of a/first.md",
  });
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
});

test("buildManifest does not mutate the input array", () => {
  const files = [
    { path: "b.md", content: "# B" },
    { path: "a.md", content: "# A" },
  ];
  buildManifest("develop", files, () => "s");
  assert.deepEqual(files.map((f) => f.path), ["b.md", "a.md"]);
});

test("renderManifest emits one compact line per entry under a header", () => {
  const manifest = {
    snapshotId: "v0.18.1-beta",
    generatedAt: "2026-09-11T00:00:00.000Z",
    entries: [
      { path: "docs/setup/cli.md", title: "CLI", summary: "Installing and running the d2e CLI." },
    ],
  };
  const rendered = renderManifest(manifest);

  assert.match(rendered, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.1-beta\)/);
  assert.match(rendered, /- docs\/setup\/cli\.md — CLI: Installing and running the d2e CLI\./);
});

test("renderManifest states the file count so the model knows the search space", () => {
  const manifest = {
    snapshotId: "develop",
    generatedAt: "2026-09-11T00:00:00.000Z",
    entries: [
      { path: "a.md", title: "A", summary: "sa" },
      { path: "b.md", title: "B", summary: "sb" },
    ],
  };
  assert.match(renderManifest(manifest), /2 files/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/manifest.test.ts`
Expected: FAIL — `Cannot find module './manifest.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/manifest.ts`:

```typescript
import type { KbFile } from "./kbFiles.js";

export interface ManifestEntry {
  path: string;
  title: string;
  summary: string;
}

export interface KbManifest {
  snapshotId: string;
  generatedAt: string;
  entries: ManifestEntry[];
}

const HEADING_RE = /^#{1,6}\s+(.+)$/m;

/** First markdown heading in the document, or a stable placeholder. */
export function extractTitle(content: string): string {
  const match = content.match(HEADING_RE);
  if (!match) return "(untitled)";
  const heading = match[1].replace(/\s*#+\s*$/, "").trim();
  return heading === "" ? "(untitled)" : heading;
}

export function buildManifest(
  snapshotId: string,
  files: KbFile[],
  summarize: (file: KbFile) => string,
): KbManifest {
  const entries = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      path: file.path,
      title: extractTitle(file.content),
      summary: summarize(file),
    }));
  return { snapshotId, generatedAt: new Date().toISOString(), entries };
}

export function renderManifest(manifest: KbManifest): string {
  const lines = [
    `KNOWLEDGE BASE INDEX (snapshot: ${manifest.snapshotId}) — ${manifest.entries.length} files.`,
    "Read files with your tools before answering. Do not answer from these summaries alone.",
    "",
    ...manifest.entries.map((e) => `- ${e.path} — ${e.title}: ${e.summary}`),
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/manifest.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/manifest.ts src/kb/manifest.test.ts
git commit -m "feat(kb): manifest index for retrieval-based answering"
```

---

## Task 2: Path scoping and traversal safety

**Files:**
- Create: `src/kb/kbScope.ts`
- Test: `src/kb/kbScope.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface KbScope { kbRoot: string; allowedPrefixes: string[] }`
  - `function scopeForSnapshot(kbRoot: string, snapshotId: string): KbScope`
  - `function isWithinScope(scope: KbScope, relPath: string): boolean`
  - `function resolveScopedPath(scope: KbScope, relPath: string): string`

**Context:** The retrieval tools take a path chosen by the model, which is influenced by user input — a trust boundary. `src/kb/kbFiles.ts` already has `safeRepoKbPath` for the *write* side; this is the read-side equivalent, and it differs in that it must permit several prefixes (the selected snapshot, the shared WebAPI contract, the curated FAQ) rather than exactly one.

`resolveScopedPath` throws rather than returning null so a mistake cannot silently read the wrong file. `isWithinScope` is the non-throwing predicate used where a boolean is wanted.

- [ ] **Step 1: Write the failing test**

Create `src/kb/kbScope.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { scopeForSnapshot, isWithinScope, resolveScopedPath } from "./kbScope.js";

const ROOT = "/tmp/kb-root";

test("scopeForSnapshot allows the snapshot, the shared contract and the curated FAQ", () => {
  const scope = scopeForSnapshot(ROOT, "v0.18.1-beta");
  assert.equal(scope.kbRoot, ROOT);
  assert.deepEqual(scope.allowedPrefixes, [
    "snapshots/v0.18.1-beta",
    "repos/_shared",
    "curated",
  ]);
});

test("isWithinScope accepts paths under an allowed prefix", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop/docs/setup/cli.md"), true);
  assert.equal(isWithinScope(scope, "repos/_shared/webapi-contract/sources.md"), true);
  assert.equal(isWithinScope(scope, "curated/faq/faq-01.md"), true);
});

test("isWithinScope rejects another snapshot", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/v0.17.1-beta/docs/setup/cli.md"), false);
});

test("isWithinScope rejects a prefix that only shares a string prefix", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop-evil/docs/x.md"), false);
});

test("isWithinScope rejects traversal out of the root", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "snapshots/develop/../../../etc/passwd"), false);
  assert.equal(isWithinScope(scope, "../secrets.md"), false);
});

test("isWithinScope rejects absolute paths", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(isWithinScope(scope, "/etc/passwd"), false);
});

test("resolveScopedPath returns an absolute path for an allowed relative path", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(
    resolveScopedPath(scope, "snapshots/develop/docs/setup/cli.md"),
    resolve(ROOT, "snapshots/develop/docs/setup/cli.md"),
  );
});

test("resolveScopedPath throws on an out-of-scope path, naming the path", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.throws(
    () => resolveScopedPath(scope, "snapshots/v0.17.1-beta/docs/x.md"),
    /outside the allowed scope.*v0\.17\.1-beta/s,
  );
});

test("resolveScopedPath allows a directory, not only markdown", () => {
  const scope = scopeForSnapshot(ROOT, "develop");
  assert.equal(
    resolveScopedPath(scope, "snapshots/develop/docs"),
    resolve(ROOT, "snapshots/develop/docs"),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/kbScope.test.ts`
Expected: FAIL — `Cannot find module './kbScope.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/kbScope.ts`:

```typescript
import { resolve, sep } from "node:path";

export interface KbScope {
  kbRoot: string;
  /** Repo-relative path prefixes the scope may read from. */
  allowedPrefixes: string[];
}

/**
 * Read scope for answering against one snapshot: that snapshot's own content,
 * plus the version-independent shared tiers (the WebAPI contract and the
 * curated FAQ).
 */
export function scopeForSnapshot(kbRoot: string, snapshotId: string): KbScope {
  return {
    kbRoot,
    allowedPrefixes: [`snapshots/${snapshotId}`, "repos/_shared", "curated"],
  };
}

function resolveIfAllowed(scope: KbScope, relPath: string): string | null {
  const root = resolve(scope.kbRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return scope.allowedPrefixes.some((prefix) => {
    const allowed = resolve(root, prefix);
    return target === allowed || target.startsWith(allowed + sep);
  })
    ? target
    : null;
}

export function isWithinScope(scope: KbScope, relPath: string): boolean {
  return resolveIfAllowed(scope, relPath) !== null;
}

export function resolveScopedPath(scope: KbScope, relPath: string): string {
  const target = resolveIfAllowed(scope, relPath);
  if (target === null) {
    throw new Error(
      `Refusing to read a path outside the allowed scope (${scope.allowedPrefixes.join(", ")}): "${relPath}".`,
    );
  }
  return target;
}
```

Note: `resolve` normalises `..` before the prefix comparison, so traversal is caught by the prefix check itself, and an absolute `relPath` replaces the root entirely and fails the root check. The message names the scope first and the offending path last so it satisfies the step-1 test's `/outside the allowed scope.*v0\.17\.1-beta/s` assertion.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/kbScope.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/kbScope.ts src/kb/kbScope.test.ts
git commit -m "feat(kb): read-side path scoping for retrieval tools"
```

---

## Task 3: Widen the stub Anthropic client type

**Files:**
- Modify: `src/shared/anthropicLike.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface AnthropicLikeBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }`
  - `interface AnthropicLikeResponse { content: AnthropicLikeBlock[]; stop_reason?: string }`
  - `interface AnthropicLikeClient { messages: { create: (...args: unknown[]) => Promise<AnthropicLikeResponse> } }`

**Context:** The current stub type models text blocks only. The retrieval loop needs to read `tool_use` blocks and branch on `stop_reason`. All new fields are optional, so every existing consumer (`answer.ts`, `repoResolution.ts`, and their tests) keeps compiling unchanged — verify that rather than assume it.

The current file reads:

```typescript
/** Minimal shape of an Anthropic SDK client, narrow enough to stub in tests. */
export interface AnthropicLikeClient {
  messages: { create: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> };
}
```

- [ ] **Step 1: Replace the file contents**

```typescript
/**
 * Minimal shape of an Anthropic SDK client, narrow enough to stub in tests.
 *
 * Every field beyond `type` is optional: a text block carries `text`, a
 * `tool_use` block carries `id`, `name` and `input`. Keeping them optional on
 * one block type — rather than a discriminated union — lets existing callers
 * that only read `text` stay unchanged.
 */
export interface AnthropicLikeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicLikeResponse {
  content: AnthropicLikeBlock[];
  /** "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" */
  stop_reason?: string;
}

export interface AnthropicLikeClient {
  messages: { create: (...args: unknown[]) => Promise<AnthropicLikeResponse> };
}
```

- [ ] **Step 2: Verify nothing regressed**

Run: `npm run typecheck && npm run typecheck:api && npm test`
Expected: typechecks clean, full suite PASSes. If any existing stub in a test no longer satisfies the type, fix the stub — do not narrow the interface back.

- [ ] **Step 3: Commit**

```bash
git add src/shared/anthropicLike.ts
git commit -m "refactor(shared): widen stub client type to carry tool-use blocks"
```

---

## Task 4: The three KB tools — schemas and executors

**Files:**
- Create: `api/_lib/kbTools.ts`
- Test: `api/_lib/kbTools.test.ts`

**Interfaces:**
- Consumes: `KbScope`, `resolveScopedPath`, `isWithinScope` from `src/kb/kbScope.js`
- Produces:
  - `const KB_TOOL_DEFS: KbToolDef[]` where `interface KbToolDef { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] } }`
  - `interface KbToolResult { content: string; isError: boolean; bytes: number }`
  - `function executeKbTool(name: string, input: Record<string, unknown>, scope: KbScope): KbToolResult`

**Context:** These execute against the bundled KB on local disk (`./knowledge-base`, cloned by `scripts/build-kb-bundle.mjs`). Every failure must come back as a *tool result* the model can recover from, never a thrown exception that kills the request — a model that asks for a nonexistent file should be told so and try again. `bytes` is returned so the loop can enforce a cumulative read budget.

`grep_kb` uses a caller-supplied regex. Guard it: reject patterns over 200 characters, and construct the `RegExp` inside a try/catch so an invalid pattern is a tool error rather than a crash.

- [ ] **Step 1: Write the failing test**

Create `api/_lib/kbTools.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { KB_TOOL_DEFS, executeKbTool } from "./kbTools.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kbtools-"));
  const docs = join(root, "snapshots", "develop", "docs", "setup");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "cli.md"), "# CLI\n\nRun `./d2e up` to start.\n");
  writeFileSync(join(docs, "tls.md"), "# TLS\n\nCertificates live in ssl/.\n");
  const other = join(root, "snapshots", "v0.17.1-beta", "docs");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "old.md"), "# Old\n\nSecret older content.\n");
  return root;
}

test("KB_TOOL_DEFS declares exactly the three retrieval tools", () => {
  assert.deepEqual(KB_TOOL_DEFS.map((t) => t.name).sort(), [
    "grep_kb",
    "list_kb_dir",
    "read_kb_file",
  ]);
  for (const def of KB_TOOL_DEFS) {
    assert.equal(def.input_schema.type, "object");
    assert.ok(def.description.length > 20, `${def.name} needs a usable description`);
  }
});

test("read_kb_file returns file contents and byte count", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("read_kb_file", { path: "snapshots/develop/docs/setup/cli.md" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /Run `\.\/d2e up` to start\./);
  assert.equal(result.bytes, result.content.length);
});

test("read_kb_file reports a missing file as a recoverable tool error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("read_kb_file", { path: "snapshots/develop/docs/nope.md" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /not found/i);
});

test("read_kb_file refuses a path in another snapshot", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool(
    "read_kb_file",
    { path: "snapshots/v0.17.1-beta/docs/old.md" },
    scope,
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /scope/i);
  assert.doesNotMatch(result.content, /Secret older content/);
});

test("read_kb_file rejects a missing or non-string path argument", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  assert.equal(executeKbTool("read_kb_file", {}, scope).isError, true);
  assert.equal(executeKbTool("read_kb_file", { path: 42 }, scope).isError, true);
});

test("grep_kb finds matches with their file and line number", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "d2e up" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /snapshots\/develop\/docs\/setup\/cli\.md:3/);
});

test("grep_kb never reaches outside the scope", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "Secret older content" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /no matches/i);
});

test("grep_kb reports an invalid regex as a tool error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "unclosed(" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /invalid/i);
});

test("grep_kb rejects an overlong pattern", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("grep_kb", { pattern: "a".repeat(201) }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /too long/i);
});

test("list_kb_dir lists entries, marking directories", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("list_kb_dir", { path: "snapshots/develop/docs" }, scope);

  assert.equal(result.isError, false);
  assert.match(result.content, /setup\/$/m);
});

test("an unknown tool name is a recoverable error", () => {
  const scope = scopeForSnapshot(makeRoot(), "develop");
  const result = executeKbTool("rm_rf", { path: "/" }, scope);

  assert.equal(result.isError, true);
  assert.match(result.content, /unknown tool/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test api/_lib/kbTools.test.ts`
Expected: FAIL — `Cannot find module './kbTools.js'`

- [ ] **Step 3: Write the implementation**

Create `api/_lib/kbTools.ts`:

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveScopedPath, type KbScope } from "../../src/kb/kbScope.js";

export interface KbToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface KbToolResult {
  content: string;
  isError: boolean;
  bytes: number;
}

const MAX_PATTERN_LENGTH = 200;
const MAX_GREP_MATCHES = 50;

export const KB_TOOL_DEFS: KbToolDef[] = [
  {
    name: "read_kb_file",
    description:
      "Read one knowledge-base file in full. Use the exact path shown in the index. " +
      "Always read a file before making a claim about its contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. snapshots/develop/docs/setup/cli.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_kb",
    description:
      "Search the knowledge base with a JavaScript regular expression. Returns matching " +
      "lines with their file and line number. Use this to locate an error message, a " +
      "config key, or a term you cannot place from the index alone.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source, max 200 chars" },
        pathPrefix: { type: "string", description: "Optional repo-relative prefix to narrow the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_kb_dir",
    description:
      "List the entries of one knowledge-base directory. Directory names end with a slash. " +
      "Use this to explore an area the index summarises only loosely.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative directory path" },
      },
      required: ["path"],
    },
  },
];

function ok(content: string): KbToolResult {
  return { content, isError: false, bytes: content.length };
}

function fail(content: string): KbToolResult {
  return { content, isError: true, bytes: content.length };
}

function stringArg(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readKbFile(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const path = stringArg(input, "path");
  if (!path) return fail('read_kb_file requires a non-empty string "path".');
  let abs: string;
  try {
    abs = resolveScopedPath(scope, path);
  } catch (err) {
    return fail((err as Error).message);
  }
  try {
    return ok(readFileSync(abs, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(`File not found: ${path}. Check the index for the exact path.`);
    }
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      return fail(`${path} is a directory. Use list_kb_dir instead.`);
    }
    return fail(`Could not read ${path}: ${(err as Error).message}`);
  }
}

function collectMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
}

function grepKb(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const pattern = stringArg(input, "pattern");
  if (!pattern) return fail('grep_kb requires a non-empty string "pattern".');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return fail(`Pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH}).`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return fail(`Invalid regular expression: ${(err as Error).message}`);
  }

  const prefix = stringArg(input, "pathPrefix");
  const searchRoots = prefix
    ? [prefix]
    : scope.allowedPrefixes;

  const files: string[] = [];
  for (const root of searchRoots) {
    let abs: string;
    try {
      abs = resolveScopedPath(scope, root);
    } catch (err) {
      return fail((err as Error).message);
    }
    collectMarkdown(abs, files);
  }

  const matches: string[] = [];
  for (const abs of files.sort()) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(scope.kbRoot, abs).split(sep).join("/");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (re.test(lines[i])) matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
    }
  }

  if (matches.length === 0) return ok(`No matches for /${pattern}/.`);
  const truncated =
    matches.length >= MAX_GREP_MATCHES
      ? `\n(truncated at ${MAX_GREP_MATCHES} matches — narrow the pattern or set pathPrefix)`
      : "";
  return ok(matches.join("\n") + truncated);
}

function listKbDir(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const path = stringArg(input, "path");
  if (!path) return fail('list_kb_dir requires a non-empty string "path".');
  let abs: string;
  try {
    abs = resolveScopedPath(scope, path);
  } catch (err) {
    return fail((err as Error).message);
  }
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(`Directory not found: ${path}`);
    }
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return fail(`${path} is a file. Use read_kb_file instead.`);
    }
    return fail(`Could not list ${path}: ${(err as Error).message}`);
  }
  if (entries.length === 0) return ok(`${path} is empty.`);
  const rendered = entries.sort().map((entry) => {
    const isDir = statSync(join(abs, entry)).isDirectory();
    return isDir ? `${entry}/` : entry;
  });
  return ok(rendered.join("\n"));
}

export function executeKbTool(
  name: string,
  input: Record<string, unknown>,
  scope: KbScope,
): KbToolResult {
  switch (name) {
    case "read_kb_file":
      return readKbFile(input, scope);
    case "grep_kb":
      return grepKb(input, scope);
    case "list_kb_dir":
      return listKbDir(input, scope);
    default:
      return fail(`Unknown tool "${name}". Available: read_kb_file, grep_kb, list_kb_dir.`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test api/_lib/kbTools.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:api
git add api/_lib/kbTools.ts api/_lib/kbTools.test.ts
git commit -m "feat(api): scoped read/grep/list tools over the knowledge base"
```

---

## Task 5: The bounded retrieval loop

**Files:**
- Create: `api/_lib/retrievalLoop.ts`
- Test: `api/_lib/retrievalLoop.test.ts`

**Interfaces:**
- Consumes: `KB_TOOL_DEFS`, `executeKbTool` from `./kbTools.js`; `KbScope` from `../../src/kb/kbScope.js`; `AnthropicLikeClient` from `../../src/shared/anthropicLike.js`
- Produces:
  - `interface RetrievalBudget { maxTurns: number; maxBytes: number }`
  - `function defaultBudget(): RetrievalBudget`
  - `interface RetrievalOutcome { text: string; turns: number; bytesRead: number; filesRead: string[]; truncated: boolean }`
  - `function runRetrievalLoop(options: RetrievalOptions): Promise<RetrievalOutcome>` where
    `interface RetrievalOptions { client: AnthropicLikeClient; model: string; maxTokens: number; system: unknown[]; messages: { role: string; content: unknown }[]; scope: KbScope; budget?: RetrievalBudget }`

**Context:** This is the heart of phase A. The loop calls the model, and while it comes back with `stop_reason === "tool_use"`, executes each requested tool and feeds results back as a `user` message of `tool_result` blocks, per the Anthropic tool-use protocol.

Two independent bounds: `maxTurns` (model calls) and `maxBytes` (cumulative tool output). Exceeding either sets `truncated` and stops the loop — the caller then asks the model once more, without tools, to answer from what it has. That final call is part of the loop's job, so the caller always receives usable text.

`filesRead` is returned for the progress display on the web surface and for debugging.

- [ ] **Step 1: Write the failing test**

Create `api/_lib/retrievalLoop.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { runRetrievalLoop } from "./retrievalLoop.js";
import type { AnthropicLikeClient, AnthropicLikeResponse } from "../../src/shared/anthropicLike.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-"));
  const dir = join(root, "snapshots", "develop", "docs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli.md"), "# CLI\n\nRun ./d2e up to start the stack.\n");
  return root;
}

/** A client that replays a fixed list of responses and records what it was sent. */
function scriptedClient(responses: AnthropicLikeResponse[]): {
  client: AnthropicLikeClient;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client: AnthropicLikeClient = {
    messages: {
      create: async (...args: unknown[]) => {
        calls.push(args[0] as Record<string, unknown>);
        if (i >= responses.length) throw new Error(`unexpected call ${i + 1}`);
        return responses[i++];
      },
    },
  };
  return { client, calls };
}

const baseOptions = (root: string) => ({
  model: "test-model",
  maxTokens: 1024,
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "how do I start the stack?" }],
  scope: scopeForSnapshot(root, "develop"),
});

test("a question answered without tools returns immediately", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    { content: [{ type: "text", text: "Run ./d2e up." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.equal(outcome.text, "Run ./d2e up.");
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.truncated, false);
  assert.deepEqual(outcome.filesRead, []);
  assert.equal(calls.length, 1);
});

test("a tool_use response is executed and fed back, then the answer is returned", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [
        { type: "tool_use", id: "t1", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Run ./d2e up. (snapshots/develop/docs/cli.md)" }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.match(outcome.text, /d2e up/);
  assert.equal(outcome.turns, 2);
  assert.deepEqual(outcome.filesRead, ["snapshots/develop/docs/cli.md"]);
  assert.ok(outcome.bytesRead > 0);

  const secondCallMessages = (calls[1].messages as { role: string; content: unknown }[]);
  const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
  assert.equal(toolResultTurn.role, "user");
  const blocks = toolResultTurn.content as { type: string; tool_use_id: string; content: string }[];
  assert.equal(blocks[0].type, "tool_result");
  assert.equal(blocks[0].tool_use_id, "t1");
  assert.match(blocks[0].content, /d2e up/);
});

test("tools are declared to the model on every call", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);

  await runRetrievalLoop({ client, ...baseOptions(root) });

  const tools = calls[0].tools as { name: string }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ["grep_kb", "list_kb_dir", "read_kb_file"]);
});

test("several tool_use blocks in one response all execute, in order", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [
        { type: "tool_use", id: "t1", name: "list_kb_dir", input: { path: "snapshots/develop/docs" } },
        { type: "tool_use", id: "t2", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ]);

  await runRetrievalLoop({ client, ...baseOptions(root) });

  const messages = calls[1].messages as { content: unknown }[];
  const blocks = messages[messages.length - 1].content as { tool_use_id: string }[];
  assert.deepEqual(blocks.map((b) => b.tool_use_id), ["t1", "t2"]);
});

test("a tool error is returned to the model rather than thrown", async () => {
  const root = makeRoot();
  const { client, calls } = scriptedClient([
    {
      content: [{ type: "tool_use", id: "t1", name: "read_kb_file", input: { path: "snapshots/develop/docs/ghost.md" } }],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "I could not find that." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.equal(outcome.text, "I could not find that.");
  const messages = calls[1].messages as { content: unknown }[];
  const blocks = messages[messages.length - 1].content as { is_error: boolean; content: string }[];
  assert.equal(blocks[0].is_error, true);
  assert.match(blocks[0].content, /not found/i);
});

test("exceeding maxTurns stops the loop and forces a final toolless answer", async () => {
  const root = makeRoot();
  const toolTurn: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client, calls } = scriptedClient([
    toolTurn,
    toolTurn,
    { content: [{ type: "text", text: "Partial answer from what I read." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({
    client,
    ...baseOptions(root),
    budget: { maxTurns: 2, maxBytes: 1_000_000 },
  });

  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text, "Partial answer from what I read.");
  // The final call must not offer tools, or the model could keep going.
  assert.equal(calls[calls.length - 1].tools, undefined);
});

test("exceeding maxBytes stops the loop and forces a final toolless answer", async () => {
  const root = makeRoot();
  const toolTurn: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client } = scriptedClient([
    toolTurn,
    { content: [{ type: "text", text: "Truncated answer." }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({
    client,
    ...baseOptions(root),
    budget: { maxTurns: 10, maxBytes: 5 },
  });

  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text, "Truncated answer.");
});

test("filesRead records each distinct file once, in read order", async () => {
  const root = makeRoot();
  const read: AnthropicLikeResponse = {
    content: [{ type: "tool_use", id: "t", name: "read_kb_file", input: { path: "snapshots/develop/docs/cli.md" } }],
    stop_reason: "tool_use",
  };
  const { client } = scriptedClient([
    read,
    read,
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ]);

  const outcome = await runRetrievalLoop({ client, ...baseOptions(root) });

  assert.deepEqual(outcome.filesRead, ["snapshots/develop/docs/cli.md"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test api/_lib/retrievalLoop.test.ts`
Expected: FAIL — `Cannot find module './retrievalLoop.js'`

- [ ] **Step 3: Write the implementation**

Create `api/_lib/retrievalLoop.ts`:

```typescript
import { KB_TOOL_DEFS, executeKbTool } from "./kbTools.js";
import type { KbScope } from "../../src/kb/kbScope.js";
import type { AnthropicLikeClient, AnthropicLikeBlock } from "../../src/shared/anthropicLike.js";

export interface RetrievalBudget {
  /** Maximum model calls before the loop is cut off. */
  maxTurns: number;
  /** Maximum cumulative bytes of tool output before the loop is cut off. */
  maxBytes: number;
}

/**
 * Read lazily rather than captured at module load: tests (and any runtime that
 * sets configuration after import) must be able to change these. A module-level
 * const would freeze whatever the environment held at first import.
 */
export function defaultBudget(): RetrievalBudget {
  return {
    maxTurns: Number(process.env.RETRIEVAL_MAX_TURNS ?? 8),
    maxBytes: Number(process.env.RETRIEVAL_MAX_BYTES ?? 400_000),
  };
}

export interface RetrievalOutcome {
  text: string;
  turns: number;
  bytesRead: number;
  filesRead: string[];
  truncated: boolean;
}

export interface RetrievalOptions {
  client: AnthropicLikeClient;
  model: string;
  maxTokens: number;
  system: unknown[];
  messages: { role: string; content: unknown }[];
  scope: KbScope;
  budget?: RetrievalBudget;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

function textOf(blocks: AnthropicLikeBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

const TRUNCATION_NOTE =
  "You have reached your search budget. Answer now from what you have already read. " +
  "Say explicitly that your search was truncated, and cite only files you actually read.";

export async function runRetrievalLoop(options: RetrievalOptions): Promise<RetrievalOutcome> {
  const budget = options.budget ?? defaultBudget();
  const messages = [...options.messages];
  const filesRead: string[] = [];

  let turns = 0;
  let bytesRead = 0;
  let truncated = false;
  let lastText = "";

  while (turns < budget.maxTurns) {
    const response = await options.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      system: options.system,
      messages,
      tools: KB_TOOL_DEFS,
    });
    turns++;

    const blocks = response.content ?? [];
    lastText = textOf(blocks);

    const toolUses = blocks.filter((b) => b.type === "tool_use" && typeof b.id === "string");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: lastText, turns, bytesRead, filesRead, truncated: false };
    }

    const results: ToolResultBlock[] = [];
    for (const use of toolUses) {
      const result = executeKbTool(use.name ?? "", use.input ?? {}, options.scope);
      bytesRead += result.bytes;
      if (use.name === "read_kb_file" && !result.isError) {
        const path = typeof use.input?.path === "string" ? use.input.path : null;
        if (path && !filesRead.includes(path)) filesRead.push(path);
      }
      results.push({
        type: "tool_result",
        tool_use_id: use.id as string,
        content: result.content,
        is_error: result.isError,
      });
    }

    messages.push({ role: "assistant", content: blocks });
    messages.push({ role: "user", content: results });

    if (bytesRead >= budget.maxBytes) {
      truncated = true;
      break;
    }
  }

  if (turns >= budget.maxTurns) truncated = true;

  // Budget exhausted: ask once more with no tools, so the caller always gets text.
  messages.push({ role: "user", content: TRUNCATION_NOTE });
  const final = await options.client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages,
  });
  turns++;

  return { text: textOf(final.content ?? []) || lastText, turns, bytesRead, filesRead, truncated };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test api/_lib/retrievalLoop.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:api
git add api/_lib/retrievalLoop.ts api/_lib/retrievalLoop.test.ts
git commit -m "feat(api): bounded agentic retrieval loop over the knowledge base"
```

---

## Task 6: Rewire `answerQuestion` onto the loop

**Files:**
- Modify: `api/_lib/answer.ts`
- Modify: `api/_lib/answer.test.ts`
- Modify: `src/kb/phase3.e2e.test.ts` (it imports `renderKbForPrompt`, which this task removes)

**Interfaces:**
- Consumes: `runRetrievalLoop`, `RetrievalOutcome` from `./retrievalLoop.js`; `buildManifest`, `renderManifest` from `../../src/kb/manifest.js`; `scopeForSnapshot` from `../../src/kb/kbScope.js`
- Produces:
  - `interface AnswerResult { text: string; covered: boolean; filesRead: string[]; truncated: boolean }` *(extended)*
  - `function answerQuestion(question: string, history?: Turn[], client?: AnthropicLikeClient, snapshotId?: string): Promise<AnswerResult>` *(signature extended)*
  - `function loadManifestText(kbRoot: string, snapshotId: string): string`

**Context:** `renderKbForPrompt` and its whole-KB budget go away. The system prompt now carries instructions plus the manifest; content arrives through tools.

The existing `AnswerResult` gains two fields. Check every call site before changing the shape:

```bash
grep -rn "answerQuestion\|AnswerResult" api src scripts --include="*.ts" | grep -v "\.test\.ts"
```

Adding fields is backward compatible for consumers that destructure `text` and `covered`, but confirm rather than assume.

Until phase C creates real snapshot directories, `snapshotId` defaults to `develop` and `loadManifestText` falls back to building a manifest on the fly from whatever `readAllRepoKbs` finds, so this task is testable and shippable before snapshots exist.

- [ ] **Step 1: Write the failing test**

Append to `api/_lib/answer.test.ts`:

```typescript
import { answerQuestion as answerQuestionRetrieval } from "./answer.js";
import type { AnthropicLikeResponse } from "../../src/shared/anthropicLike.js";

test("answerQuestion declares the KB tools and returns the model's text", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        calls.push(args[0] as Record<string, unknown>);
        return { content: [{ type: "text", text: "Use the CLI." }], stop_reason: "end_turn" };
      },
    },
  };

  const result = await answerQuestionRetrieval("how?", [], client);

  assert.equal(result.text, "Use the CLI.");
  assert.equal(result.covered, true);
  assert.deepEqual(result.filesRead, []);
  assert.equal(result.truncated, false);
  assert.ok(Array.isArray(calls[0].tools), "tools must be declared");
});

test("answerQuestion puts the manifest in the system prompt, not the KB body", async () => {
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  await answerQuestionRetrieval("how?", [], client);

  assert.match(systemText, /KNOWLEDGE BASE INDEX/);
  assert.doesNotMatch(systemText, /===== FILE:/);
});

test("answerQuestion still strips the NO_KB_MATCH sentinel", async () => {
  const client = {
    messages: {
      create: async (): Promise<AnthropicLikeResponse> => ({
        content: [{ type: "text", text: `${NO_KB_MATCH}\nNot covered here.` }],
        stop_reason: "end_turn",
      }),
    },
  };

  const result = await answerQuestionRetrieval("what?", [], client);

  assert.equal(result.covered, false);
  assert.equal(result.text, "Not covered here.");
  assert.doesNotMatch(result.text, /NO_KB_MATCH/);
});

test("answerQuestion surfaces truncation from the retrieval loop", async () => {
  let call = 0;
  const client = {
    messages: {
      create: async (): Promise<AnthropicLikeResponse> => {
        call++;
        if (call === 1) {
          return {
            content: [{ type: "tool_use", id: "t", name: "list_kb_dir", input: { path: "curated" } }],
            stop_reason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "Partial." }], stop_reason: "end_turn" };
      },
    },
  };

  const prev = process.env.RETRIEVAL_MAX_TURNS;
  process.env.RETRIEVAL_MAX_TURNS = "1";
  try {
    const result = await answerQuestionRetrieval("what?", [], client);
    assert.equal(result.truncated, true);
    assert.equal(result.text, "Partial.");
  } finally {
    if (prev === undefined) delete process.env.RETRIEVAL_MAX_TURNS;
    else process.env.RETRIEVAL_MAX_TURNS = prev;
  }
});
```

Also **delete** the two existing tests that assert on `renderKbForPrompt`'s budget behaviour (`"renderKbForPrompt forces the index-only fallback…"` and any sibling asserting `===== FILE:` rendering), since that function is being removed. Keep the `readAllRepoKbs` tests — that function stays.

Also update `src/kb/phase3.e2e.test.ts`, which imports and calls `renderKbForPrompt` in its first test. Drop that name from the import, and replace the rendered-body assertion with the same check against the files on disk:

```typescript
  const files = readAllRepoKbs(root);
  assert.ok(files.some((f) => f.path === "repos/widgets/knowledge-base/00-overview/intro.md"));
```

Keep the rest of that test (`answerQuestion` → `resolveRepoFromCitation` round-trip) unchanged; the legacy `repos/widgets/…` citation shape still resolves under the widened parser, so it continues to pass.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test api/_lib/answer.test.ts`
Expected: FAIL — the new tests fail because `answerQuestion` does not declare tools and the system prompt has no manifest.

- [ ] **Step 3: Rewrite the relevant parts of `api/_lib/answer.ts`**

Remove `renderKbForPrompt`, `cachedKbText` and `kbText`. Remove the now-unused imports of `renderKb` and `RegistryEntry`. Add:

```typescript
import { buildManifest, renderManifest } from "../../src/kb/manifest.js";
import { scopeForSnapshot } from "../../src/kb/kbScope.js";
import { runRetrievalLoop } from "./retrievalLoop.js";

export const DEFAULT_SNAPSHOT_ID = process.env.DEFAULT_SNAPSHOT_ID ?? "develop";

function kbRoot(): string {
  return process.env.KB_ROOT ?? process.cwd() + "/knowledge-base";
}

const manifestCache = new Map<string, string>();

/**
 * Manifest text for a snapshot. Prefers a prebuilt snapshots/<id>/manifest.json;
 * falls back to building one from whatever repo KBs are on disk, so this works
 * before phase C creates real snapshots.
 */
export function loadManifestText(root: string, snapshotId: string): string {
  const cacheKey = `${root}::${snapshotId}`;
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    const raw = readFileSync(join(root, "snapshots", snapshotId, "manifest.json"), "utf8");
    text = renderManifest(JSON.parse(raw));
  } catch {
    const files = readAllRepoKbs(root);
    text = renderManifest(
      buildManifest(snapshotId, files, (f) => f.content.slice(0, 140).replace(/\s+/g, " ").trim()),
    );
  }
  manifestCache.set(cacheKey, text);
  return text;
}
```

Add `readFileSync` to the `node:fs` import.

Replace the `INSTRUCTIONS` citation clause, since paths are no longer only `repos/…`:

```typescript
- Cite the EXACT source path(s) you read, formatted exactly as the index shows them
  (e.g. "snapshots/develop/docs/2-admin_guide/5-setup/0-system-setup/cli.md" or
  "curated/faq/faq-03.md") — this exact string is later parsed to resolve which source a
  correction should target, so do not paraphrase, shorten, or reformat it.
- Never state a fact you have not read with your tools. The index lists titles and
  summaries only; read the file before relying on it.
```

Replace the body of `answerQuestion`:

```typescript
export interface AnswerResult {
  text: string;
  covered: boolean;
  filesRead: string[];
  truncated: boolean;
}

export async function answerQuestion(
  question: string,
  history: Turn[] = [],
  client?: AnthropicLikeClient,
  snapshotId: string = DEFAULT_SNAPSHOT_ID,
): Promise<AnswerResult> {
  const usingOauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const anthropic = client ?? (makeClient() as unknown as AnthropicLikeClient);
  const root = kbRoot();

  const system = [
    ...(usingOauth ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }] : []),
    { type: "text" as const, text: INSTRUCTIONS },
    {
      type: "text" as const,
      text: loadManifestText(root, snapshotId),
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const messages = [
    ...history.map((t) => ({ role: t.role as string, content: t.text as unknown })),
    { role: "user", content: question as unknown },
  ];

  const outcome = await runRetrievalLoop({
    client: anthropic,
    model: process.env.ANSWER_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
    maxTokens: Number(process.env.ANSWER_MAX_TOKENS ?? 4096),
    system,
    messages,
    scope: scopeForSnapshot(root, snapshotId),
  });

  const match = outcome.text.match(NO_KB_MATCH_RE);
  const covered = !match;
  const text = covered
    ? outcome.text
    : (outcome.text.slice(0, match.index) + outcome.text.slice(match.index! + match[0].length)).replace(/^\s+/, "");

  return { text, covered, filesRead: outcome.filesRead, truncated: outcome.truncated };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm run typecheck:api && npm test`
Expected: PASS. Fix any call site the grep in Context turned up.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/answer.ts api/_lib/answer.test.ts src/kb/phase3.e2e.test.ts
git commit -m "feat(api): answer from retrieval over a manifest, not whole-KB stuffing"
```

---

## Task 7: Widen the citation parser, with a round-trip guard

**Files:**
- Modify: `src/kb/repoResolution.ts`
- Modify: `src/kb/repoResolution.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `function resolveRepoFromCitation(answerText: string): string | null` *(behaviour widened)*
  - `function hasKbCitation(answerText: string): boolean` *(behaviour widened)*
  - `const CITATION_RE: RegExp` *(exported so the round-trip test can assert against one source of truth)*

**Context:** This is the spec's known break (risk #2). The current parser only matches `repos/<name>/`. The engine can now emit four citation shapes:

| Shape | Resolves to |
|---|---|
| `snapshots/<id>/generated/<repo>/…` | `<repo>` |
| `snapshots/<id>/docs/…` | `data2evidence` — the docs site lives in the D2E repo |
| `repos/_shared/webapi-contract/…` | `null` — not correctable against a source repo |
| `curated/faq/…` | `null` — human-authored, the bot must never correct it |
| `repos/<name>/…` | `<repo>` — legacy, still emitted until phase C migrates content |

`curated/` resolving to `null` is a safety property, not an oversight: a thumbs-down on an FAQ answer must never dispatch a workflow that rewrites the project manager's copy.

- [ ] **Step 1: Write the failing test**

Append to `src/kb/repoResolution.test.ts`:

```typescript
test("resolveRepoFromCitation resolves a snapshot generated-KB path", () => {
  assert.equal(
    resolveRepoFromCitation("See snapshots/develop/generated/atlas3/02-frontend/cohort.md"),
    "atlas3",
  );
});

test("resolveRepoFromCitation maps a snapshot docs path to data2evidence", () => {
  assert.equal(
    resolveRepoFromCitation("See snapshots/v0.18.1-beta/docs/2-admin_guide/5-setup/cli.md"),
    "data2evidence",
  );
});

test("resolveRepoFromCitation still resolves the legacy repos path", () => {
  assert.equal(
    resolveRepoFromCitation("See repos/data2evidence/knowledge-base/00-overview/intro.md"),
    "data2evidence",
  );
});

test("resolveRepoFromCitation refuses to resolve a curated FAQ citation", () => {
  assert.equal(resolveRepoFromCitation("See curated/faq/faq-03.md"), null);
});

test("resolveRepoFromCitation refuses to resolve the shared WebAPI contract", () => {
  assert.equal(resolveRepoFromCitation("See repos/_shared/webapi-contract/sources.md"), null);
});

test("resolveRepoFromCitation returns null when two different repos are cited", () => {
  const text = "snapshots/develop/generated/atlas3/a.md and snapshots/develop/generated/trex/b.md";
  assert.equal(resolveRepoFromCitation(text), null);
});

test("resolveRepoFromCitation resolves when one repo is cited twice", () => {
  const text = "snapshots/develop/generated/trex/a.md and snapshots/develop/generated/trex/b.md";
  assert.equal(resolveRepoFromCitation(text), "trex");
});

test("hasKbCitation recognises every citation shape the answer engine can emit", () => {
  for (const path of [
    "repos/data2evidence/knowledge-base/00-overview/intro.md",
    "snapshots/develop/docs/2-admin_guide/5-setup/cli.md",
    "snapshots/develop/generated/trex/01-architecture/engine.md",
    "repos/_shared/webapi-contract/sources.md",
    "curated/faq/faq-01.md",
  ]) {
    assert.equal(hasKbCitation(`Answer text. ${path}`), true, `should match ${path}`);
  }
});

test("hasKbCitation does not fire on ordinary prose", () => {
  assert.equal(hasKbCitation("There are no citations in this sentence."), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/repoResolution.test.ts`
Expected: FAIL on the snapshot, curated and `_shared` cases.

- [ ] **Step 3: Write the implementation**

Replace the top of `src/kb/repoResolution.ts`:

```typescript
/**
 * Every citation shape the answer engine can emit. Exported so the round-trip
 * test asserts against one source of truth rather than a copy.
 *
 *   snapshots/<id>/generated/<repo>/...  -> <repo>
 *   snapshots/<id>/docs/...              -> data2evidence (the docs site is in that repo)
 *   repos/_shared/...                    -> not correctable
 *   curated/...                          -> never correctable; human-authored
 *   repos/<name>/...                     -> <name> (legacy)
 */
export const CITATION_RE =
  /(?:snapshots\/[^/\s]+\/(?:generated\/(?<snapRepo>[^/\s]+)|(?<docs>docs))|curated\/(?<curated>[^/\s]+)|repos\/(?<repo>[^/\s]+))\//g;

/** The repo whose docs site is vendored at snapshots/<id>/docs. */
export const DOCS_SOURCE_REPO = "data2evidence";

function citedRepos(answerText: string): Set<string> {
  const names = new Set<string>();
  for (const match of answerText.matchAll(CITATION_RE)) {
    const groups = match.groups ?? {};
    if (groups.snapRepo) names.add(groups.snapRepo);
    else if (groups.docs) names.add(DOCS_SOURCE_REPO);
    else if (groups.repo && groups.repo !== "_shared") names.add(groups.repo);
    // curated/... and repos/_shared/... are deliberately not correctable.
  }
  return names;
}

export function resolveRepoFromCitation(answerText: string): string | null {
  const names = [...citedRepos(answerText)];
  return names.length === 1 ? names[0] : null;
}

// True when the answer cites at least one KB source path — i.e. it was grounded in real
// KB content, not a "we don't have that" miss. Used to gate self-heal: an answer that cited
// the KB shouldn't trigger a "doesn't cover that yet" follow-up even if it flagged NO_KB_MATCH.
// Unlike resolveRepoFromCitation, this counts curated and shared citations as grounding:
// they are real sources, just not correctable ones.
export function hasKbCitation(answerText: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(answerText);
}
```

Note the `lastIndex` reset: `CITATION_RE` carries the `g` flag, and `RegExp.test` on a global regex is stateful. Forgetting this produces intermittent false negatives on alternate calls — exactly the kind of bug that only shows up in production.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/repoResolution.test.ts`
Expected: PASS — the new tests plus all pre-existing ones.

- [ ] **Step 5: Run the whole suite and commit**

```bash
npm run typecheck && npm run typecheck:api && npm test
git add src/kb/repoResolution.ts src/kb/repoResolution.test.ts
git commit -m "fix(kb): resolve citations across snapshot, curated and shared paths"
```

**Phase A is complete at this point.** The bot answers by navigating files rather than by prompt stuffing, and the correction flow understands every path shape the engine emits.

---

## Task 8: Restricted frontmatter parser

**Files:**
- Create: `src/kb/frontmatter.ts`
- Test: `src/kb/frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type FrontmatterValue = string | string[] | { claim: string }[]`
  - `interface ParsedFrontmatter { data: Record<string, FrontmatterValue>; body: string }`
  - `function parseFrontmatter(raw: string): ParsedFrontmatter`

**Context:** No YAML dependency is permitted, and none is needed: the FAQ frontmatter uses a small, fixed subset. Supporting exactly that subset and **throwing on anything else** is safer than a loose parser that silently misreads — a misparsed `verifiableClaims` list would mean drift detection quietly checks nothing.

The supported subset, in full:

```yaml
---
id: faq-09                        # scalar
question: How does D2E manage...  # scalar, may contain colons after the first
tags: [access-control, rbac]      # inline flow list
owner: project-manager            # scalar
lastReviewed: 2026-09-11          # scalar
verifiableClaims:                 # block list of single-key mappings
  - claim: SSO is supported via Microsoft Entra
  - claim: RBAC is fine-grained
---
```

Rules: quotes around scalars are stripped if balanced; an empty inline list `[]` yields `[]`; a block list with no items yields `[]`; unknown block-list item shapes throw.

- [ ] **Step 1: Write the failing test**

Create `src/kb/frontmatter.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.js";

test("parses scalars, inline lists and claim blocks", () => {
  const raw = [
    "---",
    "id: faq-09",
    "question: How does D2E manage access: really?",
    "tags: [access-control, rbac]",
    "owner: project-manager",
    "lastReviewed: 2026-09-11",
    "verifiableClaims:",
    "  - claim: SSO is supported via Microsoft Entra",
    "  - claim: RBAC is fine-grained",
    "---",
    "",
    "Body text here.",
  ].join("\n");

  const { data, body } = parseFrontmatter(raw);

  assert.equal(data.id, "faq-09");
  assert.equal(data.question, "How does D2E manage access: really?");
  assert.deepEqual(data.tags, ["access-control", "rbac"]);
  assert.deepEqual(data.verifiableClaims, [
    { claim: "SSO is supported via Microsoft Entra" },
    { claim: "RBAC is fine-grained" },
  ]);
  assert.equal(body, "Body text here.");
});

test("strips balanced quotes from scalars", () => {
  const raw = ['---', 'id: "faq-01"', "owner: 'pm'", "---", "b"].join("\n");
  const { data } = parseFrontmatter(raw);
  assert.equal(data.id, "faq-01");
  assert.equal(data.owner, "pm");
});

test("an empty inline list yields an empty array", () => {
  const { data } = parseFrontmatter(["---", "tags: []", "---", "b"].join("\n"));
  assert.deepEqual(data.tags, []);
});

test("a block list with no items yields an empty array", () => {
  const { data } = parseFrontmatter(["---", "verifiableClaims:", "---", "b"].join("\n"));
  assert.deepEqual(data.verifiableClaims, []);
});

test("a document with no frontmatter returns empty data and the whole body", () => {
  const { data, body } = parseFrontmatter("# Just a doc\n\nprose");
  assert.deepEqual(data, {});
  assert.equal(body, "# Just a doc\n\nprose");
});

test("blank lines and comments inside frontmatter are ignored", () => {
  const raw = ["---", "# a comment", "", "id: faq-02", "---", "b"].join("\n");
  assert.equal(parseFrontmatter(raw).data.id, "faq-02");
});

test("an unterminated frontmatter block throws", () => {
  assert.throws(() => parseFrontmatter("---\nid: faq-01\nno terminator"), /unterminated/i);
});

test("an unsupported block-list item shape throws rather than silently dropping", () => {
  const raw = ["---", "verifiableClaims:", "  - just a bare string", "---", "b"].join("\n");
  assert.throws(() => parseFrontmatter(raw), /unsupported/i);
});

test("a line that is neither a key nor a list item throws", () => {
  assert.throws(() => parseFrontmatter(["---", "garbage line", "---", "b"].join("\n")), /unsupported/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/frontmatter.test.ts`
Expected: FAIL — `Cannot find module './frontmatter.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/frontmatter.ts`:

```typescript
export type FrontmatterValue = string | string[] | { claim: string }[];

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const DELIMITER = "---";

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map(unquote).filter((item) => item !== "");
}

/**
 * Parses the restricted frontmatter subset the curated FAQ uses. Deliberately
 * strict: anything outside the subset throws, so a malformed file fails the
 * build rather than silently losing its verifiable claims.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== DELIMITER) {
    return { data: {}, body: raw.trim() };
  }

  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === DELIMITER);
  if (closing === -1) {
    throw new Error("Unterminated frontmatter block: no closing --- found.");
  }

  const data: Record<string, FrontmatterValue> = {};
  let currentListKey: string | null = null;

  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ")) {
      if (currentListKey === null) {
        throw new Error(`Unsupported frontmatter line (list item with no key): "${trimmed}"`);
      }
      const item = trimmed.slice(2).trim();
      const claimMatch = item.match(/^claim:\s*(.+)$/);
      if (!claimMatch) {
        throw new Error(`Unsupported frontmatter list item (expected "claim: ..."): "${item}"`);
      }
      (data[currentListKey] as { claim: string }[]).push({ claim: unquote(claimMatch[1]) });
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`Unsupported frontmatter line: "${trimmed}"`);
    }
    const [, key, rest] = keyMatch;

    if (rest === "") {
      data[key] = [] as { claim: string }[];
      currentListKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = parseInlineList(rest);
      currentListKey = null;
    } else {
      data[key] = unquote(rest);
      currentListKey = null;
    }
  }

  return { data, body: lines.slice(closing + 1).join("\n").trim() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/frontmatter.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/frontmatter.ts src/kb/frontmatter.test.ts
git commit -m "feat(kb): restricted frontmatter parser for curated content"
```

---

## Task 9: FAQ types, parsing and loading

**Files:**
- Create: `src/kb/faq.ts`
- Test: `src/kb/faq.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` from `./frontmatter.js`
- Produces:
  - `interface FaqEntry { id: string; question: string; tags: string[]; owner: string; lastReviewed: string; verifiableClaims: { claim: string }[]; body: string; path: string }`
  - `function parseFaqFile(relPath: string, raw: string): FaqEntry`
  - `function loadFaq(kbRoot: string): FaqEntry[]`
  - `function renderFaqForPrompt(entries: FaqEntry[]): string`

**Context:** `parseFaqFile` validates every required field and throws with the file path in the message — a malformed FAQ file must fail loudly at build time, not degrade an answer at request time.

`loadFaq` returns `[]` when `curated/faq/` does not exist, so phase A keeps working before phase B content lands.

`renderFaqForPrompt` emits the whole FAQ, because tier-1 authority is only real if the content is always present. All 13 entries are roughly 1,000 words — cheap enough to ship every request.

- [ ] **Step 1: Write the failing test**

Create `src/kb/faq.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFaqFile, loadFaq, renderFaqForPrompt } from "./faq.js";

const VALID = [
  "---",
  "id: faq-03",
  "question: What level of technical support does Data4Life provide?",
  "tags: [support, sla]",
  "owner: project-manager",
  "lastReviewed: 2026-09-11",
  "verifiableClaims:",
  "  - claim: There is no 24/7 commercial SLA",
  "---",
  "",
  "Community support via Slack, GitHub and email.",
].join("\n");

test("parseFaqFile reads every field", () => {
  const entry = parseFaqFile("curated/faq/faq-03.md", VALID);
  assert.equal(entry.id, "faq-03");
  assert.equal(entry.path, "curated/faq/faq-03.md");
  assert.deepEqual(entry.tags, ["support", "sla"]);
  assert.deepEqual(entry.verifiableClaims, [{ claim: "There is no 24/7 commercial SLA" }]);
  assert.match(entry.body, /Community support/);
});

test("parseFaqFile throws, naming the file, when a required field is missing", () => {
  const raw = ["---", "id: faq-04", "---", "body"].join("\n");
  assert.throws(() => parseFaqFile("curated/faq/faq-04.md", raw), /faq-04\.md.*question/s);
});

test("parseFaqFile throws when the body is empty", () => {
  const raw = VALID.replace("Community support via Slack, GitHub and email.", "");
  assert.throws(() => parseFaqFile("curated/faq/faq-03.md", raw), /empty body/i);
});

test("parseFaqFile tolerates absent optional lists", () => {
  const raw = [
    "---",
    "id: faq-05",
    "question: Q?",
    "owner: project-manager",
    "lastReviewed: 2026-09-11",
    "---",
    "A.",
  ].join("\n");
  const entry = parseFaqFile("curated/faq/faq-05.md", raw);
  assert.deepEqual(entry.tags, []);
  assert.deepEqual(entry.verifiableClaims, []);
});

test("loadFaq reads every file, sorted by id", () => {
  const root = mkdtempSync(join(tmpdir(), "faq-"));
  const dir = join(root, "curated", "faq");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "faq-03.md"), VALID);
  writeFileSync(join(dir, "faq-01.md"), VALID.replace("faq-03", "faq-01"));

  const entries = loadFaq(root);
  assert.deepEqual(entries.map((e) => e.id), ["faq-01", "faq-03"]);
  assert.deepEqual(entries.map((e) => e.path), ["curated/faq/faq-01.md", "curated/faq/faq-03.md"]);
});

test("loadFaq returns an empty array when there is no curated FAQ yet", () => {
  const root = mkdtempSync(join(tmpdir(), "faq-empty-"));
  assert.deepEqual(loadFaq(root), []);
});

test("renderFaqForPrompt emits every entry with its question, path and body", () => {
  const entries = [parseFaqFile("curated/faq/faq-03.md", VALID)];
  const rendered = renderFaqForPrompt(entries);

  assert.match(rendered, /CURATED FAQ \(TIER 1/);
  assert.match(rendered, /Q: What level of technical support/);
  assert.match(rendered, /curated\/faq\/faq-03\.md/);
  assert.match(rendered, /Community support via Slack/);
});

test("renderFaqForPrompt says so when the FAQ is empty", () => {
  assert.match(renderFaqForPrompt([]), /no curated FAQ entries/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/faq.test.ts`
Expected: FAIL — `Cannot find module './faq.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/faq.ts`:

```typescript
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.js";

export interface FaqEntry {
  id: string;
  question: string;
  tags: string[];
  owner: string;
  lastReviewed: string;
  verifiableClaims: { claim: string }[];
  body: string;
  /** Repo-relative path, used verbatim as the citation. */
  path: string;
}

const REQUIRED_SCALARS = ["id", "question", "owner", "lastReviewed"] as const;

function scalar(
  data: Record<string, FrontmatterValue>,
  key: string,
  relPath: string,
): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${relPath}: frontmatter field "${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function parseFaqFile(relPath: string, raw: string): FaqEntry {
  const { data, body } = parseFrontmatter(raw);
  for (const key of REQUIRED_SCALARS) scalar(data, key, relPath);
  if (body.trim() === "") {
    throw new Error(`${relPath}: FAQ entry has an empty body.`);
  }
  const tags = Array.isArray(data.tags) ? (data.tags as string[]).filter((t) => typeof t === "string") : [];
  const claims = Array.isArray(data.verifiableClaims)
    ? (data.verifiableClaims as { claim: string }[]).filter((c) => c && typeof c.claim === "string")
    : [];

  return {
    id: scalar(data, "id", relPath),
    question: scalar(data, "question", relPath),
    owner: scalar(data, "owner", relPath),
    lastReviewed: scalar(data, "lastReviewed", relPath),
    tags,
    verifiableClaims: claims,
    body: body.trim(),
    path: relPath,
  };
}

export function loadFaq(kbRoot: string): FaqEntry[] {
  const dir = join(kbRoot, "curated", "faq");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .sort()
    .map((name) => parseFaqFile(`curated/faq/${name}`, readFileSync(join(dir, name), "utf8")))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function renderFaqForPrompt(entries: FaqEntry[]): string {
  if (entries.length === 0) {
    return "CURATED FAQ (TIER 1): there are no curated FAQ entries configured.";
  }
  const header = [
    `CURATED FAQ (TIER 1 — HIGHEST AUTHORITY, ${entries.length} entries).`,
    "Human-authored and reviewed. For questions about legal terms, licensing, pricing,",
    "support commitments, or company policy, answer from these entries ONLY, staying close",
    "to the wording below. Never infer such an answer from code or documentation, and never",
    "extend a commitment these entries do not make. Cite the entry's path.",
    "",
  ].join("\n");

  const body = entries
    .map((e) => [`--- ${e.path} ---`, `Q: ${e.question}`, `A: ${e.body}`].join("\n"))
    .join("\n\n");

  return `${header}${body}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/faq.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/faq.ts src/kb/faq.test.ts
git commit -m "feat(kb): curated FAQ loading and prompt rendering"
```

---

## Task 10: Author the 13 curated FAQ files

**Files:**
- Create (in the **`ask-d2e-kb`** repo, not this one): `curated/faq/faq-01.md` … `curated/faq/faq-13.md`
- Create: `curated/faq/README.md`

**Interfaces:**
- Consumes: the frontmatter contract from Task 9
- Produces: the tier-1 content `loadFaq` reads

**Context:** This task is **content, in the other repository**. Source material is the project manager's FAQ document, extracted at `/tmp/faq.txt` during design (regenerate with `pdftotext -layout "2609_FAQ list_Data4Life.pdf" /tmp/faq.txt` if absent).

Question → file mapping, preserving the document's own numbering:

| File | Question |
|---|---|
| `faq-01.md` | How can one start using Data2Evidence? Any legal documentation required? |
| `faq-02.md` | How is Data2Evidence currently maintained as open-source software? |
| `faq-03.md` | What level of technical support, training, and onboarding does Data4Life provide? |
| `faq-04.md` | How does Data2Evidence integrate with OHDSI Atlas 3.0 and other OHDSI tools? |
| `faq-05.md` | What tools does Data2Evidence provide for non-technical vs advanced researchers? |
| `faq-06.md` | Where is Data2Evidence hosted, and how does it protect patient data privacy? |
| `faq-07.md` | What technical infrastructure is required to deploy and scale Data2Evidence? |
| `faq-08.md` | What are the user capacity limits and system performance expectations? |
| `faq-09.md` | How does Data2Evidence manage multi-user access, permissions, and DataMarts? |
| `faq-10.md` | Does Data2Evidence support the ETL process to map raw data to OMOP CDM? |
| `faq-11.md` | What automated data quality and validation checks are built in? |
| `faq-12.md` | How does federated querying work across institutions without moving raw data? |
| `faq-13.md` | Can Data2Evidence handle multimodal health data beyond standard EMR tables? |

**Copy the answer prose verbatim from the source document.** Do not improve, condense, or rephrase it. This is commercially reviewed copy; the whole point of tier 1 is that a human wrote these exact words.

**Two entries are unfinished and must not ship as-is** (spec risk #5):

- **faq-01** ends with the editorial note *"Add details regarding technical requirements for D2E installation (docker, etc.)"*. Drop the note from the body and set `status: draft` in frontmatter.
- **faq-10** trails off with *"But there may be another arrangement…"*. Drop the trailing fragment and set `status: draft`.

`status` is an optional scalar; `parseFaqFile` ignores unknown keys, so no code change is needed. Raise both with the project manager — faq-01's gap is fillable from the docs site once phase C lands; faq-10's needs a business answer.

- [ ] **Step 1: Extract the source text**

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon
pdftotext -layout "2609_FAQ list_Data4Life.pdf" /tmp/faq.txt
wc -l /tmp/faq.txt   # expect ~166 lines
```

- [ ] **Step 2: Write `curated/faq/README.md` in the KB repo**

```markdown
# Curated FAQ (tier 1)

Human-authored answers to questions real prospective partners have asked.

**This directory is never written by the bot.** Edits happen by pull request,
reviewed by the owner named in each file's frontmatter.

These entries are the highest-authority tier: for questions about legal terms,
licensing, pricing, support commitments or company policy, the bot answers from
here or declines. It must never infer such an answer from source code or
documentation.

## Frontmatter contract

```yaml
---
id: faq-09                          # required, matches the filename
question: ...                       # required, the canonical question
tags: [access-control, rbac]        # optional
owner: project-manager              # required
lastReviewed: 2026-09-11            # required, ISO date
status: draft                       # optional; omit when the entry is final
verifiableClaims:                   # optional; checked against source by the daily refresh
  - claim: SSO is supported via Microsoft Entra
---
```

`verifiableClaims` drive drift detection: the daily job checks each claim against
the current `develop` knowledge base and alerts an admin when one looks stale. It
never edits this directory.
```

- [ ] **Step 3: Write each entry**

`curated/faq/faq-03.md`, complete, as the pattern to follow for the other twelve:

```markdown
---
id: faq-03
question: What level of technical support, training, and onboarding does Data4Life provide?
tags: [support, onboarding, sla, community]
owner: project-manager
lastReviewed: 2026-09-11
verifiableClaims:
  - claim: Data4Life does not offer a 24/7 commercial SLA for Data2Evidence
  - claim: Community support is provided via the Data2Evidence Slack channel, GitHub and email
---

While Data4Life does not provide regular tutorials or onboarding training, we do offer
"hand-holding" during technical setup if required by the partners. The "hand-holding" session
intends to help the partners build internal capabilities to operate the platform independently,
ensuring self-sustainability.

Data4Life does not offer 24/7 commercial service level agreement (SLA) support for
Data2Evidence users. Instead, we provide community support via Data2Evidence Slack
channel, GitHub and email.
```

And `curated/faq/faq-01.md`, showing the draft marking:

```markdown
---
id: faq-01
question: How can one start using Data2Evidence? Any legal documentation required?
tags: [getting-started, legal, licensing]
owner: project-manager
lastReviewed: 2026-09-11
status: draft
verifiableClaims:
  - claim: Installing Data2Evidence requires no MOU or agreement with Data4Life
  - claim: Data2Evidence is open-source
---

Installing Data2Evidence does not require a formal Memorandum of Understanding (MOU) or
any other agreement with Data4Life because the software is open-source. Interested individuals
can visit Data2Evidence Github repository and documentation page for step-by-step installation
instructions.
```

Write the remaining eleven the same way, copying each answer verbatim from `/tmp/faq.txt` and deriving `verifiableClaims` only from statements that source code or documentation could confirm or refute — capacity numbers, named integrations, supported formats, licence. Do not add claims for business facts such as collaboration partners or support policy; those cannot be checked against a repository and would produce permanent false alerts.

- [ ] **Step 4: Verify every file parses**

From the `ask-d2e` repo, with the KB repo checked out alongside:

```bash
npx tsx -e '
import { loadFaq } from "./src/kb/faq.js";
const entries = loadFaq("../ask-d2e-kb");
console.log(`parsed ${entries.length} entries`);
for (const e of entries) console.log(`  ${e.id}  claims=${e.verifiableClaims.length}  ${e.question.slice(0, 60)}`);
if (entries.length !== 13) { console.error("expected 13 entries"); process.exit(1); }
'
```

Expected: 13 entries listed, exit 0.

- [ ] **Step 5: Commit in the KB repo**

```bash
cd ../ask-d2e-kb
git add curated/
git commit -m "docs(faq): curated tier-1 FAQ from the partner FAQ document"
```

---

## Task 11: Ship the FAQ whole, with tier-precedence rules

**Files:**
- Modify: `api/_lib/answer.ts`
- Modify: `api/_lib/answer.test.ts`

**Interfaces:**
- Consumes: `loadFaq`, `renderFaqForPrompt` from `../../src/kb/faq.js`
- Produces: no new exports; `answerQuestion`'s system prompt gains the FAQ block and tier rules

**Context:** Tier authority is only real if it is stated as a rule and the content is always present. The FAQ block goes into the system prompt ahead of the manifest, inside the cached segment.

The tier-precedence rules are added to `INSTRUCTIONS`. The decline rule matters most commercially: for legal, licensing, pricing and support questions the bot must decline rather than fall back to tiers 2 or 3, because an inferred answer to "what's your SLA?" is a statement the company did not authorise.

- [ ] **Step 1: Write the failing test**

Append to `api/_lib/answer.test.ts`:

```typescript
import { mkdtempSync as mkdtemp2, mkdirSync as mkdir2, writeFileSync as write2 } from "node:fs";

function rootWithFaq(): string {
  const root = mkdtemp2(join(tmpdir(), "answer-faq-"));
  const dir = join(root, "curated", "faq");
  mkdir2(dir, { recursive: true });
  write2(
    join(dir, "faq-03.md"),
    [
      "---",
      "id: faq-03",
      "question: What support does Data4Life provide?",
      "owner: project-manager",
      "lastReviewed: 2026-09-11",
      "---",
      "No 24/7 SLA. Community support only.",
    ].join("\n"),
  );
  return root;
}

test("the curated FAQ is shipped whole in the system prompt", async () => {
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = rootWithFaq();
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  try {
    await answerQuestionRetrieval("what support?", [], client);
    assert.match(systemText, /CURATED FAQ \(TIER 1/);
    assert.match(systemText, /No 24\/7 SLA\. Community support only\./);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});

test("the system prompt states tier precedence and the decline rule", async () => {
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = rootWithFaq();
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  try {
    await answerQuestionRetrieval("anything", [], client);
    assert.match(systemText, /TIER PRECEDENCE/);
    assert.match(systemText, /decline/i);
    assert.match(systemText, /contract specification/i);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test api/_lib/answer.test.ts`
Expected: FAIL — no FAQ block and no tier rules in the system prompt.

- [ ] **Step 3: Add the tier rules and the FAQ block**

In `api/_lib/answer.ts`, add the import:

```typescript
import { loadFaq, renderFaqForPrompt } from "../../src/kb/faq.js";
```

Append to `INSTRUCTIONS`, before the Slack-formatting paragraph:

```typescript
TIER PRECEDENCE — the knowledge base has three tiers of differing authority:
- Tier 1, the curated FAQ (curated/faq/*.md): human-written and commercially reviewed.
  For any question about legal terms, licensing, pricing, support commitments, SLAs, or
  company policy, answer from tier 1 ONLY, staying close to its wording. If tier 1 does not
  cover such a question, decline and say it needs a human — never infer the answer from
  documentation or code, and never promise something tier 1 does not promise.
- Tier 2, the official documentation (snapshots/<id>/docs/**): written by the maintainers.
  For how-to, setup, configuration and troubleshooting questions about a running install,
  tier 2 outranks tier 3. Quote its steps rather than reconstructing them.
- Tier 3, the generated knowledge base (snapshots/<id>/generated/**): derived from source
  code. Use it for how things work internally and for cross-component behaviour.
- The OHDSI WebAPI material (repos/_shared/webapi-contract/**) is an upstream contract
  specification that Data2Evidence reimplements in Deno. It is NOT shipped in a
  Data2Evidence install. Always label it as contract specification, and never present it
  as the behaviour of a running install.
- When tiers disagree, say so and cite both. Do not silently pick one.
```

Add a cached FAQ loader alongside the manifest cache:

```typescript
const faqCache = new Map<string, string>();

function faqText(root: string): string {
  const cached = faqCache.get(root);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = renderFaqForPrompt(loadFaq(root));
  } catch (err) {
    // A malformed curated file must be loud, but must not take the bot down.
    console.error(`Failed to load curated FAQ from ${root}: ${(err as Error).message}`);
    text = renderFaqForPrompt([]);
  }
  faqCache.set(root, text);
  return text;
}
```

And insert the block into the system array in `answerQuestion`, between `INSTRUCTIONS` and the manifest:

```typescript
    { type: "text" as const, text: faqText(root) },
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm run typecheck:api && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/_lib/answer.ts api/_lib/answer.test.ts
git commit -m "feat(api): ship the curated FAQ whole and enforce tier precedence"
```

**Phase B is complete at this point.** Commercial and support questions are answered from human-authored copy, or declined.

---

## Task 12: Deterministic Docusaurus extraction

**Files:**
- Create: `src/kb/docsExtract.ts`
- Test: `src/kb/docsExtract.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` from `./frontmatter.js`
- Produces:
  - `interface ExtractedDoc { outPath: string; sourcePath: string; title: string; content: string }`
  - `function stripMdx(body: string): string`
  - `function rewriteRelativeLinks(body: string, sourcePath: string): string`
  - `function docOutputPath(sourcePath: string): string`
  - `function extractDoc(sourcePath: string, raw: string): ExtractedDoc`
  - `function extractDocsTree(docsRoot: string): ExtractedDoc[]`

**Context:** Tier 2 must reach the answer unaltered (Global Constraints), so this is string transformation only — no model involved.

What has to change, and why:

- **Docusaurus frontmatter** (`sidebar_position`, `id`, `title`) is navigation metadata, noise in a prompt. Strip it, but keep `title` if present — it is a better title than a guessed one.
- **MDX imports and JSX components** (`import Tabs from '@theme/Tabs'`, `<Tabs>`, `</TabItem>`) are renderer syntax. Strip the import lines and the bare component tags, keeping the prose between them.
- **Relative links** (`./cli.md`, `../setup/README.md`) break once files move. Rewrite them to KB-relative paths so a cited link still resolves.
- **`README.md` → `index.md`**: Docusaurus treats a directory's `README.md` as its index. Renaming makes the KB tree unambiguous.

The parser must be robust to real files: `docs/website/docs/` has 56 of them, nested up to five levels.

- [ ] **Step 1: Write the failing test**

Create `src/kb/docsExtract.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripMdx, rewriteRelativeLinks, docOutputPath, extractDoc, extractDocsTree } from "./docsExtract.js";

test("stripMdx removes import lines", () => {
  const body = ["import Tabs from '@theme/Tabs';", "", "# Title", "", "Prose."].join("\n");
  const out = stripMdx(body);
  assert.doesNotMatch(out, /import Tabs/);
  assert.match(out, /# Title/);
  assert.match(out, /Prose\./);
});

test("stripMdx removes standalone JSX tags but keeps the prose inside", () => {
  const body = ["<Tabs>", "<TabItem value=\"mac\">", "", "Install with brew.", "", "</TabItem>", "</Tabs>"].join("\n");
  const out = stripMdx(body);
  assert.doesNotMatch(out, /<Tabs>|<TabItem|<\/TabItem>|<\/Tabs>/);
  assert.match(out, /Install with brew\./);
});

test("stripMdx leaves inline HTML in prose alone", () => {
  assert.match(stripMdx("Use the <code>d2e</code> binary."), /<code>d2e<\/code>/);
});

test("stripMdx collapses runs of blank lines left behind", () => {
  const out = stripMdx(["# T", "", "", "", "Prose."].join("\n"));
  assert.doesNotMatch(out, /\n{3,}/);
});

test("rewriteRelativeLinks resolves a sibling link against the output tree", () => {
  const body = "See [the CLI guide](./cli.md).";
  const out = rewriteRelativeLinks(body, "2-admin_guide/5-setup/0-system-setup/env-vars.md");
  assert.match(out, /\(2-admin_guide\/5-setup\/0-system-setup\/cli\.md\)/);
});

test("rewriteRelativeLinks resolves a parent link", () => {
  const body = "See [setup](../README.md).";
  const out = rewriteRelativeLinks(body, "2-admin_guide/5-setup/0-system-setup/env-vars.md");
  assert.match(out, /\(2-admin_guide\/5-setup\/index\.md\)/);
});

test("rewriteRelativeLinks leaves absolute and external links alone", () => {
  const body = "[site](https://data2evidence.org) and [root](/docs/intro)";
  const out = rewriteRelativeLinks(body, "a/b.md");
  assert.match(out, /https:\/\/data2evidence\.org/);
  assert.match(out, /\(\/docs\/intro\)/);
});

test("docOutputPath renames README.md to index.md", () => {
  assert.equal(docOutputPath("1-user_guide/README.md"), "1-user_guide/index.md");
  assert.equal(docOutputPath("1-user_guide/4-Cohorts/README.md"), "1-user_guide/4-Cohorts/index.md");
  assert.equal(docOutputPath("2-admin_guide/5-setup/0-system-setup/cli.md"), "2-admin_guide/5-setup/0-system-setup/cli.md");
});

test("docOutputPath rewrites .mdx to .md", () => {
  assert.equal(docOutputPath("a/b.mdx"), "a/b.md");
});

test("extractDoc prefers the frontmatter title", () => {
  const raw = ["---", "sidebar_position: 3", "title: The CLI", "---", "", "# cli", "", "Prose."].join("\n");
  const doc = extractDoc("2-admin_guide/cli.md", raw);
  assert.equal(doc.title, "The CLI");
  assert.equal(doc.outPath, "2-admin_guide/cli.md");
  assert.equal(doc.sourcePath, "2-admin_guide/cli.md");
  assert.doesNotMatch(doc.content, /sidebar_position/);
});

test("extractDoc falls back to the first heading when frontmatter has no title", () => {
  const raw = ["---", "sidebar_position: 3", "---", "", "# The CLI", "", "Prose."].join("\n");
  assert.equal(extractDoc("a/cli.md", raw).title, "The CLI");
});

test("extractDoc prepends a provenance line naming the source", () => {
  const doc = extractDoc("a/cli.md", "# CLI\n\nProse.");
  assert.match(doc.content, /^<!-- source: docs\/website\/docs\/a\/cli\.md -->/);
});

test("extractDocsTree walks nested directories and skips non-markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(root, "2-admin_guide", "5-setup"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Index\n\nTop.");
  writeFileSync(join(root, "2-admin_guide", "5-setup", "cli.md"), "# CLI\n\nProse.");
  writeFileSync(join(root, "2-admin_guide", "5-setup", "diagram.png"), "not markdown");

  const docs = extractDocsTree(root);

  assert.deepEqual(docs.map((d) => d.outPath), ["2-admin_guide/5-setup/cli.md", "index.md"]);
});

test("extractDocsTree returns an empty array when the docs root is absent", () => {
  assert.deepEqual(extractDocsTree(join(tmpdir(), "definitely-not-here-12345")), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/docsExtract.test.ts`
Expected: FAIL — `Cannot find module './docsExtract.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/docsExtract.ts`:

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface ExtractedDoc {
  /** Path within the snapshot's docs/ directory. */
  outPath: string;
  /** Path within the source docs/website/docs/ tree. */
  sourcePath: string;
  title: string;
  content: string;
}

/** Where the docs site lives inside the Data2Evidence repository. */
export const DOCS_SOURCE_PREFIX = "docs/website/docs";

const IMPORT_RE = /^\s*import\s+.+?from\s+['"].+?['"];?\s*$/gm;
const EXPORT_RE = /^\s*export\s+(?:default|const)\s+.+$/gm;
const STANDALONE_JSX_RE = /^\s*<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>\s*$/gm;

/**
 * Removes MDX renderer syntax, keeping the prose. Only tags on their own line
 * and starting with a capital letter are removed, so inline HTML such as
 * <code> in running prose survives.
 */
export function stripMdx(body: string): string {
  return body
    .replace(IMPORT_RE, "")
    .replace(EXPORT_RE, "")
    .replace(STANDALONE_JSX_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LINK_RE = /\[([^\]]*)\]\((\.[^)\s]*)\)/g;

/** Rewrites ./ and ../ links to paths relative to the docs output root. */
export function rewriteRelativeLinks(body: string, sourcePath: string): string {
  const dir = posix.dirname(sourcePath);
  return body.replace(LINK_RE, (whole, label: string, href: string) => {
    const [target, hash = ""] = href.split("#");
    if (target === "") return whole;
    const resolved = posix.normalize(posix.join(dir, target));
    if (resolved.startsWith("..")) return whole;
    return `[${label}](${docOutputPath(resolved)}${hash ? `#${hash}` : ""})`;
  });
}

export function docOutputPath(sourcePath: string): string {
  return sourcePath.replace(/\.mdx$/, ".md").replace(/(^|\/)README\.md$/, "$1index.md");
}

export function extractDoc(sourcePath: string, raw: string): ExtractedDoc {
  const { data, body } = parseFrontmatter(raw);
  const stripped = rewriteRelativeLinks(stripMdx(body), sourcePath);
  const frontmatterTitle = typeof data.title === "string" ? data.title.trim() : "";
  const headingTitle = stripped.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? "";
  const title = frontmatterTitle || headingTitle || "(untitled)";
  const provenance = `<!-- source: ${DOCS_SOURCE_PREFIX}/${sourcePath} -->`;

  return {
    outPath: docOutputPath(sourcePath),
    sourcePath,
    title,
    content: `${provenance}\n\n${stripped}\n`,
  };
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

export function extractDocsTree(docsRoot: string): ExtractedDoc[] {
  const sourcePaths: string[] = [];
  try {
    walk(docsRoot, docsRoot, sourcePaths);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return sourcePaths
    .sort()
    .map((sourcePath) => extractDoc(sourcePath, readFileSync(join(docsRoot, sourcePath), "utf8")))
    .sort((a, b) => (a.outPath < b.outPath ? -1 : a.outPath > b.outPath ? 1 : 0));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/docsExtract.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Smoke-test against the real docs tree**

```bash
npx tsx -e '
import { extractDocsTree } from "./src/kb/docsExtract.js";
const docs = extractDocsTree("../upstream/Data2Evidence/docs/website/docs");
console.log(`extracted ${docs.length} docs`);
const untitled = docs.filter((d) => d.title === "(untitled)");
console.log(`untitled: ${untitled.length}`, untitled.map((d) => d.outPath));
const leftoverMdx = docs.filter((d) => /^\s*<[A-Z]/m.test(d.content));
console.log(`with leftover JSX: ${leftoverMdx.length}`, leftoverMdx.map((d) => d.outPath));
'
```

Expected: ~56 docs, few or no untitled, no leftover JSX. If any file shows leftover JSX, add a regression test for that exact shape before extending `stripMdx` — do not widen the regex blind.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/docsExtract.ts src/kb/docsExtract.test.ts
git commit -m "feat(kb): deterministic extraction of the D2E docs site"
```

---

## Task 13: Troubleshooting section indexing

**Files:**
- Create: `src/kb/troubleshooting.ts`
- Test: `src/kb/troubleshooting.test.ts`

**Interfaces:**
- Consumes: `ExtractedDoc` from `./docsExtract.js`
- Produces:
  - `interface TroubleshootingEntry { symptom: string; cause: string; resolution: string; sourcePath: string }`
  - `function extractTroubleshooting(doc: ExtractedDoc): TroubleshootingEntry[]`
  - `function buildTroubleshootingIndex(docs: ExtractedDoc[]): TroubleshootingEntry[]`
  - `function renderTroubleshootingIndex(entries: TroubleshootingEntry[]): string`

**Context:** Installed partners arrive with an error string, not a topic. A symptom-keyed index lets `grep_kb` land on the right entry from the error text alone.

The real shape in the D2E docs:

```markdown
## Troubleshooting

### `illegal hardware instruction` when running `./d2e`

**Cause:** The binary downloaded does not match your system architecture.

**Resolution:** Check your architecture and re-download the correct binary.
```

So: find an `## Troubleshooting` section, take each `###` within it as a symptom, and pull `**Cause:**` and `**Resolution:**` from the body. Be tolerant — some entries may use `**Fix:**`, or omit a cause entirely. Missing parts become empty strings rather than dropping the entry: a symptom with a resolution and no stated cause is still useful.

- [ ] **Step 1: Write the failing test**

Create `src/kb/troubleshooting.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTroubleshooting, buildTroubleshootingIndex, renderTroubleshootingIndex } from "./troubleshooting.js";

function doc(content: string, outPath = "2-admin_guide/cli.md") {
  return { outPath, sourcePath: outPath, title: "CLI", content };
}

const WITH_SECTION = [
  "# CLI",
  "",
  "Prose about the CLI.",
  "",
  "## Troubleshooting",
  "",
  "### `illegal hardware instruction` when running `./d2e`",
  "",
  "**Cause:** The binary does not match your system architecture.",
  "",
  "**Resolution:** Check your architecture and re-download the correct binary.",
  "",
  "### Port 8001 already in use",
  "",
  "**Cause:** Another process holds the port.",
  "",
  "**Resolution:** Stop the other process or change CADDY__PORT.",
  "",
  "## Next steps",
  "",
  "Unrelated content that must not be swept in.",
].join("\n");

test("extractTroubleshooting finds every symptom in the section", () => {
  const entries = extractTroubleshooting(doc(WITH_SECTION));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].symptom, "`illegal hardware instruction` when running `./d2e`");
  assert.match(entries[0].cause, /does not match your system architecture/);
  assert.match(entries[0].resolution, /re-download the correct binary/);
  assert.equal(entries[0].sourcePath, "2-admin_guide/cli.md");
});

test("extractTroubleshooting stops at the next h2", () => {
  const entries = extractTroubleshooting(doc(WITH_SECTION));
  assert.deepEqual(entries.map((e) => e.symptom), [
    "`illegal hardware instruction` when running `./d2e`",
    "Port 8001 already in use",
  ]);
  assert.ok(entries.every((e) => !/Unrelated content/.test(e.resolution)));
});

test("extractTroubleshooting returns nothing for a doc with no such section", () => {
  assert.deepEqual(extractTroubleshooting(doc("# CLI\n\nJust prose.")), []);
});

test("extractTroubleshooting matches the heading case-insensitively", () => {
  const content = ["## troubleshooting", "", "### Thing broke", "", "**Resolution:** Fix it."].join("\n");
  assert.equal(extractTroubleshooting(doc(content)).length, 1);
});

test("extractTroubleshooting accepts Fix as a synonym for Resolution", () => {
  const content = ["## Troubleshooting", "", "### Thing broke", "", "**Fix:** Turn it off and on."].join("\n");
  assert.match(extractTroubleshooting(doc(content))[0].resolution, /Turn it off and on/);
});

test("extractTroubleshooting keeps an entry that states no cause", () => {
  const content = ["## Troubleshooting", "", "### Thing broke", "", "**Resolution:** Fix it."].join("\n");
  const entries = extractTroubleshooting(doc(content));
  assert.equal(entries[0].cause, "");
  assert.match(entries[0].resolution, /Fix it/);
});

test("buildTroubleshootingIndex merges across docs, sorted by symptom", () => {
  const a = doc(["## Troubleshooting", "", "### Zebra fails", "", "**Resolution:** z"].join("\n"), "a.md");
  const b = doc(["## Troubleshooting", "", "### Apple fails", "", "**Resolution:** a"].join("\n"), "b.md");
  const index = buildTroubleshootingIndex([a, b]);
  assert.deepEqual(index.map((e) => e.symptom), ["Apple fails", "Zebra fails"]);
});

test("renderTroubleshootingIndex emits each entry with its source path", () => {
  const rendered = renderTroubleshootingIndex(extractTroubleshooting(doc(WITH_SECTION)));
  assert.match(rendered, /TROUBLESHOOTING INDEX/);
  assert.match(rendered, /Port 8001 already in use/);
  assert.match(rendered, /2-admin_guide\/cli\.md/);
});

test("renderTroubleshootingIndex says so when there is nothing indexed", () => {
  assert.match(renderTroubleshootingIndex([]), /no troubleshooting entries/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/troubleshooting.test.ts`
Expected: FAIL — `Cannot find module './troubleshooting.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/troubleshooting.ts`:

```typescript
import type { ExtractedDoc } from "./docsExtract.js";

export interface TroubleshootingEntry {
  symptom: string;
  cause: string;
  resolution: string;
  /** Path of the doc this came from, used as the citation. */
  sourcePath: string;
}

const SECTION_RE = /^##\s+troubleshooting\s*$/im;
const NEXT_H2_RE = /^##\s+/m;
const SYMPTOM_SPLIT_RE = /^###\s+/m;

function labelled(block: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[A-Z]|$)`, "i");
    const match = block.match(re);
    if (match) return match[1].trim().replace(/\s*\n\s*/g, " ");
  }
  return "";
}

export function extractTroubleshooting(doc: ExtractedDoc): TroubleshootingEntry[] {
  const start = doc.content.search(SECTION_RE);
  if (start === -1) return [];

  const afterHeading = doc.content.slice(start).replace(SECTION_RE, "");
  const nextH2 = afterHeading.search(NEXT_H2_RE);
  const section = nextH2 === -1 ? afterHeading : afterHeading.slice(0, nextH2);

  return section
    .split(SYMPTOM_SPLIT_RE)
    .slice(1)
    .map((block) => {
      const newline = block.indexOf("\n");
      const symptom = (newline === -1 ? block : block.slice(0, newline)).trim();
      const body = newline === -1 ? "" : block.slice(newline + 1);
      return {
        symptom,
        cause: labelled(body, ["Cause"]),
        resolution: labelled(body, ["Resolution", "Fix", "Workaround"]),
        sourcePath: doc.outPath,
      };
    })
    .filter((entry) => entry.symptom !== "");
}

export function buildTroubleshootingIndex(docs: ExtractedDoc[]): TroubleshootingEntry[] {
  return docs
    .flatMap(extractTroubleshooting)
    .sort((a, b) => (a.symptom < b.symptom ? -1 : a.symptom > b.symptom ? 1 : 0));
}

export function renderTroubleshootingIndex(entries: TroubleshootingEntry[]): string {
  if (entries.length === 0) {
    return "TROUBLESHOOTING INDEX: no troubleshooting entries were found in the documentation.";
  }
  const lines = [
    `TROUBLESHOOTING INDEX — ${entries.length} known symptoms from the official documentation.`,
    "Match the user's error text against a symptom, then read the source file for full context.",
    "",
  ];
  for (const e of entries) {
    lines.push(`### ${e.symptom}`);
    if (e.cause) lines.push(`Cause: ${e.cause}`);
    if (e.resolution) lines.push(`Resolution: ${e.resolution}`);
    lines.push(`Source: ${e.sourcePath}`, "");
  }
  return lines.join("\n").trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/troubleshooting.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Smoke-test against the real docs**

```bash
npx tsx -e '
import { extractDocsTree } from "./src/kb/docsExtract.js";
import { buildTroubleshootingIndex } from "./src/kb/troubleshooting.js";
const index = buildTroubleshootingIndex(extractDocsTree("../upstream/Data2Evidence/docs/website/docs"));
console.log(`indexed ${index.length} symptoms`);
for (const e of index) console.log(`  [${e.sourcePath}] ${e.symptom}`);
const noFix = index.filter((e) => e.resolution === "");
console.log(`entries with no resolution: ${noFix.length}`);
'
```

Expected: a handful of symptoms across the six docs that mention troubleshooting. Entries with no resolution suggest a label variant `labelled` does not know — add a test for that shape, then extend the label list.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/kb/troubleshooting.ts src/kb/troubleshooting.test.ts
git commit -m "feat(kb): symptom-keyed troubleshooting index from the docs site"
```

---

## Task 14: Docs-tier build orchestrator

**Files:**
- Create: `src/kb/buildDocsTier.ts`
- Test: `src/kb/buildDocsTier.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `extractDocsTree`, `ExtractedDoc` from `./docsExtract.js`; `buildTroubleshootingIndex`, `renderTroubleshootingIndex` from `./troubleshooting.js`; `buildManifest`, `renderManifest` from `./manifest.js`
- Produces:
  - `interface BuildDocsTierOptions { docsRoot: string; kbRoot: string; snapshotId: string }`
  - `interface BuildDocsTierResult { docsWritten: number; troubleshootingEntries: number; manifestEntries: number; outputDir: string }`
  - `function summariseDoc(doc: ExtractedDoc): string`
  - `function buildDocsTier(options: BuildDocsTierOptions): BuildDocsTierResult`

**Context:** The end-to-end tier-2 build: read the docs tree, write extracted markdown into `snapshots/<id>/docs/`, write `troubleshooting.md` and `manifest.json`, and report what it did.

`summariseDoc` produces the manifest's one-line summary deterministically — first non-heading, non-comment, non-empty line, truncated to 160 characters. The spec allows an LLM summariser here, but a deterministic one keeps this task testable and self-contained; swapping it later means changing one function.

Writes are confined under `snapshots/<snapshotId>/docs`. Validate each output path before writing, mirroring `safeRepoKbPath`'s discipline on the existing write paths.

- [ ] **Step 1: Write the failing test**

Create `src/kb/buildDocsTier.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summariseDoc, buildDocsTier } from "./buildDocsTier.js";

function makeDocsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "docsroot-"));
  mkdirSync(join(root, "2-admin_guide", "5-setup"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Getting started\n\nWelcome to Data2Evidence.");
  writeFileSync(
    join(root, "2-admin_guide", "5-setup", "cli.md"),
    [
      "---",
      "title: The CLI",
      "---",
      "",
      "# CLI",
      "",
      "Run ./d2e up to start the stack.",
      "",
      "## Troubleshooting",
      "",
      "### Port 8001 already in use",
      "",
      "**Cause:** Another process holds the port.",
      "",
      "**Resolution:** Stop it or change the port.",
    ].join("\n"),
  );
  return root;
}

test("summariseDoc uses the first real prose line, not the heading or provenance", () => {
  const doc = {
    outPath: "a.md",
    sourcePath: "a.md",
    title: "A",
    content: "<!-- source: docs/website/docs/a.md -->\n\n# A\n\nThe actual summary line.\n",
  };
  assert.equal(summariseDoc(doc), "The actual summary line.");
});

test("summariseDoc truncates long lines", () => {
  const doc = {
    outPath: "a.md",
    sourcePath: "a.md",
    title: "A",
    content: `# A\n\n${"x".repeat(300)}\n`,
  };
  const summary = summariseDoc(doc);
  assert.ok(summary.length <= 163, `got ${summary.length}`);
  assert.match(summary, /…$/);
});

test("summariseDoc falls back to the title when there is no prose", () => {
  assert.equal(summariseDoc({ outPath: "a.md", sourcePath: "a.md", title: "A", content: "# A\n" }), "A");
});

test("buildDocsTier writes docs, the troubleshooting index and a manifest", () => {
  const docsRoot = makeDocsRoot();
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout-"));

  const result = buildDocsTier({ docsRoot, kbRoot, snapshotId: "develop" });

  assert.equal(result.docsWritten, 2);
  assert.equal(result.troubleshootingEntries, 1);
  assert.equal(result.manifestEntries, 3); // 2 docs + troubleshooting.md

  const cliPath = join(kbRoot, "snapshots", "develop", "docs", "2-admin_guide", "5-setup", "cli.md");
  assert.ok(existsSync(cliPath));
  assert.match(readFileSync(cliPath, "utf8"), /Run \.\/d2e up/);

  assert.ok(existsSync(join(kbRoot, "snapshots", "develop", "docs", "index.md")));
  assert.match(
    readFileSync(join(kbRoot, "snapshots", "develop", "troubleshooting.md"), "utf8"),
    /Port 8001 already in use/,
  );
});

test("buildDocsTier's manifest paths are the paths the retrieval tools accept", () => {
  const docsRoot = makeDocsRoot();
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout2-"));
  buildDocsTier({ docsRoot, kbRoot, snapshotId: "develop" });

  const manifest = JSON.parse(
    readFileSync(join(kbRoot, "snapshots", "develop", "manifest.json"), "utf8"),
  );

  assert.equal(manifest.snapshotId, "develop");
  for (const entry of manifest.entries) {
    assert.match(entry.path, /^snapshots\/develop\//, `bad manifest path: ${entry.path}`);
    assert.ok(existsSync(join(kbRoot, entry.path)), `manifest lists a missing file: ${entry.path}`);
  }
});

test("buildDocsTier on an absent docs root writes nothing and reports zero", () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "kbout3-"));
  const result = buildDocsTier({
    docsRoot: join(tmpdir(), "definitely-not-here-98765"),
    kbRoot,
    snapshotId: "develop",
  });

  assert.equal(result.docsWritten, 0);
  assert.equal(result.manifestEntries, 0);
  assert.equal(existsSync(join(kbRoot, "snapshots", "develop", "manifest.json")), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/kb/buildDocsTier.test.ts`
Expected: FAIL — `Cannot find module './buildDocsTier.js'`

- [ ] **Step 3: Write the implementation**

Create `src/kb/buildDocsTier.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { extractDocsTree, type ExtractedDoc } from "./docsExtract.js";
import { buildTroubleshootingIndex, renderTroubleshootingIndex } from "./troubleshooting.js";
import { buildManifest, renderManifest } from "./manifest.js";
import type { KbFile } from "./kbFiles.js";

export interface BuildDocsTierOptions {
  /** Absolute path to a checkout's docs/website/docs directory. */
  docsRoot: string;
  /** Absolute path to the ask-d2e-kb working copy. */
  kbRoot: string;
  snapshotId: string;
}

export interface BuildDocsTierResult {
  docsWritten: number;
  troubleshootingEntries: number;
  manifestEntries: number;
  outputDir: string;
}

const SUMMARY_MAX = 160;

/** First real prose line of a doc, for the manifest. Deterministic by design. */
export function summariseDoc(doc: ExtractedDoc): string {
  const line = doc.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("<!--"));
  if (!line) return doc.title;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line;
}

function safeSnapshotPath(kbRoot: string, snapshotId: string, relPath: string): string {
  const snapshotRoot = resolve(kbRoot, "snapshots", snapshotId);
  const target = resolve(snapshotRoot, relPath);
  if (!target.startsWith(snapshotRoot + sep)) {
    throw new Error(`Refusing to write outside snapshots/${snapshotId}/: "${relPath}"`);
  }
  return target;
}

function write(kbRoot: string, snapshotId: string, relPath: string, content: string): void {
  const abs = safeSnapshotPath(kbRoot, snapshotId, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content.endsWith("\n") ? content : `${content}\n`);
}

export function buildDocsTier(options: BuildDocsTierOptions): BuildDocsTierResult {
  const { docsRoot, kbRoot, snapshotId } = options;
  const outputDir = resolve(kbRoot, "snapshots", snapshotId);
  const docs = extractDocsTree(docsRoot);

  if (docs.length === 0) {
    return { docsWritten: 0, troubleshootingEntries: 0, manifestEntries: 0, outputDir };
  }

  for (const doc of docs) {
    write(kbRoot, snapshotId, `docs/${doc.outPath}`, doc.content);
  }

  const troubleshooting = buildTroubleshootingIndex(docs);
  const troubleshootingText = renderTroubleshootingIndex(troubleshooting);
  write(kbRoot, snapshotId, "troubleshooting.md", troubleshootingText);

  // Manifest paths are repo-relative so the retrieval tools accept them verbatim.
  const manifestFiles: KbFile[] = [
    ...docs.map((doc) => ({
      path: `snapshots/${snapshotId}/docs/${doc.outPath}`,
      content: doc.content,
    })),
    {
      path: `snapshots/${snapshotId}/troubleshooting.md`,
      content: troubleshootingText,
    },
  ];
  const summaries = new Map(
    docs.map((doc) => [`snapshots/${snapshotId}/docs/${doc.outPath}`, summariseDoc(doc)]),
  );
  const manifest = buildManifest(snapshotId, manifestFiles, (file) =>
    summaries.get(file.path) ??
    `Known symptoms and resolutions from the official documentation (${troubleshooting.length} entries).`,
  );
  write(kbRoot, snapshotId, "manifest.json", JSON.stringify(manifest, null, 2));

  console.log(renderManifest(manifest).split("\n").slice(0, 2).join("\n"));

  return {
    docsWritten: docs.length,
    troubleshootingEntries: troubleshooting.length,
    manifestEntries: manifest.entries.length,
    outputDir,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/kb/buildDocsTier.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
    "kb-build-docs": "tsx src/kb/buildDocsTierCli.ts",
```

Create `src/kb/buildDocsTierCli.ts`:

```typescript
import { buildDocsTier } from "./buildDocsTier.js";
import { required, optional } from "../shared/config.js";

const result = buildDocsTier({
  docsRoot: required("DOCS_ROOT"),
  kbRoot: required("KB_ROOT"),
  snapshotId: optional("SNAPSHOT_ID", "develop"),
});

console.log(
  `Wrote ${result.docsWritten} docs, ${result.troubleshootingEntries} troubleshooting entries, ` +
    `${result.manifestEntries} manifest entries to ${result.outputDir}`,
);

if (result.docsWritten === 0) {
  console.error("No docs were found — check DOCS_ROOT.");
  process.exit(1);
}
```

- [ ] **Step 6: Build the real develop docs tier end to end**

```bash
DOCS_ROOT="$(cd ../upstream/Data2Evidence/docs/website/docs && pwd)" \
KB_ROOT="$(cd ../ask-d2e-kb && pwd)" \
SNAPSHOT_ID=develop \
npm run kb-build-docs
```

Expected: roughly 56 docs written, a non-zero troubleshooting count, and `snapshots/develop/{docs,troubleshooting.md,manifest.json}` present in the KB repo.

Then verify the retrieval path reads it:

```bash
KB_ROOT="$(cd ../ask-d2e-kb && pwd)" npx tsx -e '
import { scopeForSnapshot } from "./src/kb/kbScope.js";
import { executeKbTool } from "./api/_lib/kbTools.js";
const scope = scopeForSnapshot(process.env.KB_ROOT, "develop");
const hit = executeKbTool("grep_kb", { pattern: "illegal hardware instruction" }, scope);
console.log(hit.isError ? `ERROR: ${hit.content}` : hit.content);
'
```

Expected: a match inside `snapshots/develop/`. This is the end-to-end proof that phase C content is reachable through the phase A retrieval tools.

- [ ] **Step 7: Run the whole suite and commit**

```bash
npm run typecheck && npm run typecheck:api && npm test
git add src/kb/buildDocsTier.ts src/kb/buildDocsTier.test.ts src/kb/buildDocsTierCli.ts package.json
git commit -m "feat(kb): build the docs tier into a snapshot with manifest and troubleshooting index"
```

Then commit the generated content in the KB repo:

```bash
cd ../ask-d2e-kb
git add snapshots/develop
git commit -m "docs(kb): build develop docs tier from the D2E documentation site"
```

**Phase C is complete at this point.**

---

## Done criteria

- [ ] `npm run typecheck && npm run typecheck:api && npm test` passes.
- [ ] `answerQuestion` declares tools and sends no whole-KB body — the system prompt contains `KNOWLEDGE BASE INDEX` and `CURATED FAQ (TIER 1`, and no `===== FILE:` block.
- [ ] `renderKbForPrompt` is gone.
- [ ] Every citation shape the answer engine can emit resolves through `resolveRepoFromCitation`, and `curated/` resolves to `null`.
- [ ] All 13 FAQ entries parse; faq-01 and faq-10 carry `status: draft`.
- [ ] `snapshots/develop/` in `ask-d2e-kb` contains `docs/`, `troubleshooting.md` and `manifest.json`.
- [ ] `grep_kb` finds a real troubleshooting symptom inside `snapshots/develop/`.

## Follow-on work, explicitly not in this plan

Phases D–G from the spec: snapshot machinery and the pin extractor (D), onboarding Atlas3/trex/WebAPI (E), scheduled refresh with new-release detection and FAQ drift detection (F), and the public web surface (G). Each gets its own plan once C is proven in production.

Two seams this plan deliberately leaves stubbed:

- `answerQuestion`'s `snapshotId` parameter exists and is honoured, but nothing yet offers a version picker. Slack and web both get `develop` until phase D.
- `verifiableClaims` are parsed and validated but nothing consumes them. Drift detection is phase F.
