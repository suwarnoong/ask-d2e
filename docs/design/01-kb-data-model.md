# Phase 1: Multi-repo data model + KB repo layout + path-safety

## `ask-d2e-kb` repo layout

```
ask-d2e-kb/
├── repos.json
└── repos/
    └── <name>/
        └── knowledge-base/
            ├── 00-overview/...
            ├── 01-.../...
            └── ...
```

`repos.json` is an array of `RegistryEntry`:

```ts
interface PromptSpec {
  audience: string;              // freeform, crafted by the wizard
  exampleQuestions: string[];
  focusAreas: string[];          // what the KB should prioritize covering
  scopeNotes: string;            // anything explicitly out of scope
}

interface RegistryEntry {
  name: string;                  // slug, used as the folder name under repos/
  sourceRepo: string;             // "owner/name"
  promptSpec: PromptSpec;
  cadence: "daily" | "weekly";
  status: "active" | "pending-initial-build";
  createdBy: string;              // Slack user id
  createdAt: string;              // ISO
  lastRefreshedAt: string | null;     // ISO, null until the first successful build/refresh
  lastAutoRefreshAt: string | null;   // ISO, null until the first self-heal attempt (see
                                       // docs/design/03-qa-and-correction.md) — bumped on every
                                       // attempt, whether or not it found anything, so a burst of
                                       // similar misses can't retrigger a job every time
}
```

**Setup status**: the `ask-d2e-kb` GitHub repo has been created (private) but is currently empty (no default branch yet). Still outstanding, as the first concrete implementation step of this phase (not done during planning): commit an initial `repos.json` containing `[]` and a short README describing this layout, establishing the default branch.

## Registry I/O (`src/kb/registry.ts`)

```ts
function loadRegistry(kbRoot: string): RegistryEntry[]  // JSON.parse(readFileSync(join(kbRoot, "repos.json")))

function isDue(entry: RegistryEntry, now: Date): boolean {
  if (!entry.lastRefreshedAt) return true; // never refreshed — always due
  const elapsedMs = now.getTime() - new Date(entry.lastRefreshedAt).getTime();
  const thresholdMs = entry.cadence === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return elapsedMs >= thresholdMs;
}

const AUTO_REFRESH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function canAutoRefresh(entry: RegistryEntry, now: Date): boolean {
  if (!entry.lastAutoRefreshAt) return true; // never attempted — no cooldown yet
  return now.getTime() - new Date(entry.lastAutoRefreshAt).getTime() >= AUTO_REFRESH_COOLDOWN_MS;
}
```

### Retry-safe registry mutation

`repos.json` is a single shared file that multiple Actions can race to edit (two admins onboarding repos back-to-back, a scheduled refresh overlapping a correction). A plain textual `git rebase` is fragile for a JSON array — adjacent-entry edits can produce a real conflict even though they're logically independent. Instead:

```ts
async function withRegistryRetry(
  kbRoot: string,
  branch: string,
  mutate: (entries: RegistryEntry[]) => RegistryEntry[], // pure function, no side effects
  commitMessage: string,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    git(kbRoot, ["fetch", "origin", branch]);
    git(kbRoot, ["reset", "--hard", `origin/${branch}`]); // start from the latest remote state
    const current = loadRegistry(kbRoot);
    const next = mutate(current);
    writeFileSync(join(kbRoot, "repos.json"), JSON.stringify(next, null, 2) + "\n");
    git(kbRoot, ["add", "repos.json"]);
    if (!git(kbRoot, ["status", "--porcelain", "repos.json"])) return; // mutate was a no-op
    git(kbRoot, ["-c", "user.name=ask-d2e", "-c", "user.email=actions@github.com", "commit", "-m", commitMessage]);
    try {
      git(kbRoot, ["push", "origin", `HEAD:${branch}`]);
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      // another writer landed first — loop: refetch, re-apply mutate against the new base, retry
    }
  }
}
```

Any markdown-file changes that accompany a registry mutation (e.g. the initial-build's new KB pages, or a refresh's edits) should be committed **in the same commit** as the `repos.json` change when they're part of one logical operation, so a partial failure can't leave the registry pointing at content that was never pushed. Because those markdown paths are disjoint per repo, they can still use the simpler textual `pushWithRebase` (below) for the file-writing part; `withRegistryRetry` specifically owns the registry-array read-modify-write cycle.

## Path safety (`src/kb/kbFiles.ts`)

Generalizes single-repo path validation to also check the repo name matches:

```ts
function safeRepoKbPath(kbRoot: string, repoName: string, relPath: string): string {
  const repoRoot = resolve(kbRoot, "repos", repoName, "knowledge-base");
  const target = resolve(kbRoot, relPath);
  if (target !== repoRoot && !target.startsWith(repoRoot + sep)) {
    throw new Error(`Refusing to write outside repos/${repoName}/knowledge-base/: "${relPath}"`);
  }
  if (!target.endsWith(".md")) throw new Error(`Refusing to write a non-markdown file: "${relPath}"`);
  return target;
}
```

This rejects `../` traversal, absolute-path escapes, non-markdown targets, and — new here — a change whose path claims a *different* repo's folder than the one the current job is scoped to.

### Reading + rendering a repo's KB

```ts
interface KbFile { path: string; content: string } // path tagged as "repos/<name>/<category>/<file>.md"

function readRepoKb(kbRoot: string, repoName: string): KbFile[]
// walk repos/<name>/knowledge-base/**/*.md, sorted, path relative to kbRoot (so citations are unambiguous)

const KB_CONTENT_BUDGET = 600_000; // chars, total across files

function renderKb(files: KbFile[]): string {
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total <= KB_CONTENT_BUDGET) {
    return files.map(f => `===== FILE: ${f.path} =====\n${f.content}`).join("\n\n");
  }
  // over budget: render a path + first-markdown-heading index only, with a warning banner,
  // so the model is told to be conservative about editing files it can't see in full.
}
```

The budget check happens **per repo** during a single-repo write (refresh/initial-build/correction, which only ever touch one repo's files at a time) but the Q&A path (Phase 3) needs a budget across *all* repos combined — see that doc for how the merged-context path handles growth.

### Applying changes

```ts
interface KbChange { path: string; action: "update" | "create"; rationale: string; source_prs: number[]; content: string }
interface KbPlan { summary: string; changes: KbChange[] }

function applyKbChanges(changes: KbChange[], kbRoot: string, repoName: string): string[] {
  // validate EVERY path via safeRepoKbPath before writing anything (atomic-ish: one bad
  // entry aborts the whole batch instead of leaving a half-applied write)
  // mkdir -p the parent dir, write content (ensure trailing newline)
  // return the written repo-relative paths
}
```

## Git commit/push (`src/kb/gitOps.ts`)

For the markdown-file side of a mutation (disjoint paths per repo, so textual conflicts are rare):

```ts
function commitAndPush(kbRoot: string, plan: KbPlan, repoName: string, branch: string, subjectOverride?: string): boolean {
  git(kbRoot, ["add", `repos/${repoName}/knowledge-base`]);
  if (!git(kbRoot, ["status", "--porcelain", `repos/${repoName}/knowledge-base`])) return false; // no-op
  const subject = subjectOverride ?? `docs(kb): update ${repoName}`;
  const body = [plan.summary, "", ...plan.changes.map(c => `- ${c.action} ${c.path}: ${c.rationale}`)].join("\n");
  git(kbRoot, ["-c", "user.name=ask-d2e", "-c", "user.email=actions@github.com", "commit", "-m", `${subject}\n\n${body}`]);
  pushWithRebase(kbRoot, branch);
  return true;
}

function pushWithRebase(kbRoot: string, branch: string, attempts = 3): void {
  for (let attempt = 1; ; attempt++) {
    try { git(kbRoot, ["push", "origin", `HEAD:${branch}`]); return; }
    catch (err) {
      if (attempt >= attempts) throw err;
      git(kbRoot, ["fetch", "origin", branch]);
      try { git(kbRoot, ["rebase", "FETCH_HEAD"]); }
      catch (rebaseErr) { git(kbRoot, ["rebase", "--abort"]); throw rebaseErr; } // no half-finished rebase
    }
  }
}
```

## Robust JSON-plan parsing (`src/kb/responseParsing.ts`)

Claude is asked to return one JSON object; in practice it sometimes wraps it in prose or a fenced block. Parsing must be tolerant but never let malformed output reach disk:

```ts
function stripFences(text: string): string // strip a single ```json ... ``` wrapper if present

function balancedFrom(text: string, start: number): string | null
// return the balanced {...} substring starting at `start`, string-literal aware
// (so a brace inside a quoted string doesn't throw off the depth count)

function jsonCandidates(text: string): string[]
// collect: every fenced ```json block, THEN every balanced {...} found by scanning for "{"
// (best-first order: fenced blocks are more likely to be the intended answer)

function parseKbResponse(text: string): KbPlan {
  // try stripFences(text) first, then each jsonCandidates(text) entry;
  // take the first candidate that JSON.parses AND has an array `.changes` field
  // validate each change: path is non-empty string, action is "update"|"create",
  // content is non-empty string, source_prs is number[] (default [])
  // throw with a truncated excerpt of the raw text if nothing valid is found
}
```

This must never be "best-effort" about validation — a plan that fails validation should abort the whole job rather than write partial/malformed content.

## Verification

- `npm run typecheck`.
- A local fixture test (no network/credentials): construct a small `repos.json` fixture, round-trip it through `loadRegistry` → a pure mutate function (add/remove/bump-timestamp) → assert the resulting array; assert `safeRepoKbPath` rejects `../../etc/passwd`, a `.txt` target, and a path naming a different repo than the one passed in.
- Manually inspect `parseKbResponse` against a few adversarial fixtures: prose-wrapped JSON, a reply with two `{...}` blocks (one being an inline example inside the rationale text), a reply missing `changes` entirely.
