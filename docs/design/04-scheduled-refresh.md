# Phase 4: Generalized scheduled refresh (single daily cron)

## Incremental update prompt (`src/kb/incrementalPrompt.ts`)

Per-repo, injecting that repo's `PromptSpec` for context:

```
"You maintain a Markdown knowledge base documenting <sourceRepo> for <promptSpec.audience>.
Below are (1) the current KB files for this repo and (2) merged PRs over the last window,
with actual code diffs. Compare diffs against current docs; propose edits where merged code
makes a documented behavior/name/number/flow/feature out of date, AND draft NEW pages for
substantial features with no coverage yet — prioritizing promptSpec.focusAreas.
Rules:
- Base every change on the ACTUAL DIFF, not just PR titles/bodies. Never invent details.
- The diff tells you what changed and where; it is a POINTER, not the only source of truth —
  the full checked-out source is available via Read/Grep/Glob. If a diff is truncated,
  ambiguous, or you need to see a full file or its callers to judge the change's real effect,
  read the actual current file instead of guessing from the diff alone.
- Be conservative: an EMPTY changes array is correct and expected on most runs.
- 'update' replaces a file in FULL (not a patch); preserve existing structure/tone, change
  only what the diff requires. 'create' adds a new file under repos/<name>/knowledge-base/
  following the existing category convention (00-overview, 01-..., etc.).
- GitHub-Flavored Markdown matching existing files (# headings, -/1. bullets, fenced code)
  — this is NOT Slack, no single-asterisk-only bold, no Slack link syntax."
Output: KbPlan JSON — { summary, changes: [{ path, action, rationale, source_prs, content }] }.
```

The PR dataset serialized into the prompt: `repo`, `window_start`, `totals`, and per-PR `{ number, title, author, html_url, additions, deletions, changed_files, labels, body_excerpt, files, diff, diff_truncated }` — exactly the shape `gatherRepoPrs` (see `00-foundations.md`) already produces.

## `refresh.ts` entrypoint

```
1. loadRegistry(kbRoot).
2. dueEntries = entries.filter(e => isDue(e, now)).
3. If dueEntries.length === 0: log and exit — nothing to do this run.
4. For each due entry (sequentially, or with modest concurrency if the entry count grows large):
   a. sinceIso = entry.lastRefreshedAt ?? (now - cadenceWindowMs)
   b. data = gatherRepoPrs(entry.sourceRepo, sinceIso, SOURCE_REPOS_TOKEN)
      — Octokit-only, no checkout needed just to LIST the window's merged PRs and their diffs.
   c. If data.totals.prCount === 0 and skipIfEmpty: skip this entry (no KB call needed).
   d. Shallow-clone entry.sourceRepo into a scratch dir (e.g. ./src-checkout/<name>) — see
      "Verifying against ground truth" below for why this is no longer optional.
   e. kb = readRepoKb(kbRoot, entry.name)
   f. plan = parseKbResponse(await callClaude(incrementalPrompt(data, kb, entry.promptSpec), auth,
      { cwd: "./src-checkout/<name>", allowedTools: ["Read", "Grep", "Glob"] }))
   g. if plan.changes.length: applyKbChanges(...), accumulate { entry, plan, written } for the
      combined commit below. If plan.changes.length === 0: nothing to write, but still mark
      this entry as "processed" so its lastRefreshedAt advances (an empty-changes result on a
      due repo is a normal, successful refresh — not a skip).
5. If nothing was processed at all (every due entry had zero PRs and skipIfEmpty): exit without
   committing.
6. withRegistryRetry: bump lastRefreshedAt = now for every processed entry (whether or not it
   had file changes) in ONE mutation.
7. One commit covering ALL touched markdown files across all processed repos PLUS the
   repos.json bump (single push — avoids one push-per-repo racing against itself; the registry
   mutation above is separate/retry-safe specifically because it's the one thing genuinely
   prone to concurrent-writer races with the wizard/correction flows running at other times).
8. curl the deploy hook if anything changed.
9. Slack notice: one message listing every repo refreshed and its change count (not one message
   per repo — keep the daily notice scannable).
```

## Verifying against ground truth when the diff alone isn't enough

A unified diff has two structural limits that can make the prompt mislead Claude even when it isn't lying to it: (1) diffs are capped at 24,000 chars per PR (`docs/design/00-foundations.md`) — a large PR gets truncated mid-file, and everything past the cap is invisible; (2) even an untruncated diff only shows changed lines plus a few lines of surrounding context, not the whole file or how the changed code is used elsewhere — a signature change whose callers sit outside the diff can look smaller or larger than it really is.

The original design treated this as diff-only and relied on the vote-down/correction flow (`docs/design/03-qa-and-correction.md`) as the sole backstop: correction *does* check out the real source with `Read`/`Grep`/`Glob`, so a bad incremental edit eventually gets caught and fixed — but only reactively, after a user hits a wrong answer.

**Change:** the incremental refresh now shallow-clones each due entry's `sourceRepo` (step 4d above) and runs with the same `allowedTools: ["Read", "Grep", "Glob"]` access initial-build and correction already have, rather than trusting the diff text in isolation. The diff still drives *what to look at* (it's what makes the prompt cheap and targeted instead of re-exploring the whole repo every run), but Claude can now open the actual current file — the diff is a pointer, not the only source of truth. The incremental prompt should say so explicitly: "The diff tells you what changed and where; if it's truncated, ambiguous, or you need to see a full file or its callers, use Read/Grep/Glob against the checked-out source rather than guessing from the diff alone."

This trades a per-due-repo clone (cheap on an Actions runner, and only for entries that are actually due today) for meaningfully lower risk of confidently-wrong KB edits. It also means `SOURCE_REPOS_TOKEN` now needs checkout (not just API-read) access for the refresh job, same as it already does for initial-build and correction — see the updated token matrix in `docs/PLAN.md`.

## Workflow: `.github/workflows/kb-refresh.yml`

```yaml
on:
  schedule:
    - cron: "0 23 * * *"   # once daily; per-repo cadence (daily/weekly) is decided inside the
                            # job via isDue(), NOT by having multiple cron schedules
  workflow_dispatch: {}     # manual trigger for testing, no per-repo inputs needed —
                            # it just re-evaluates isDue() against whatever's in the registry

permissions:
  contents: write

concurrency:
  group: kb-refresh
  cancel-in-progress: false

jobs:
  refresh:
    steps:
      - checkout ask-d2e (code)
      - checkout ask-d2e-kb into ./kb (KB_REPO_TOKEN, push target)
      - setup-node, npm ci, npm i -g @anthropic-ai/claude-code
      - run npm run kb-refresh
        env: CLAUDE_CODE_OAUTH_TOKEN, SOURCE_REPOS_TOKEN, CLAUDE_TIMEOUT_MS: "600000",
             VERCEL_DEPLOY_HOOK_URL, SLACK_WEBHOOK_URL
```

No `D2E_REPO`-style single-repo variable — the entire due-set comes from `repos.json`, read fresh at the start of the job. The per-due-entry clone (step 4d above) is a plain `git clone --depth 1` invoked from inside `refresh.ts` itself (using `SOURCE_REPOS_TOKEN` via an `x-access-token@` URL), not a static `actions/checkout` step in the YAML — the set of repos to clone is only known once `repos.json` and `isDue()` are evaluated at runtime, the same reason `kb-correct.yml` can't use a static checkout either (`docs/design/03-qa-and-correction.md`).

## Verification

- Dry-run against a fixture `repos.json` with mixed `cadence` values and a spread of `lastRefreshedAt` timestamps (some overdue, some not due yet, one `null`) to confirm `isDue` math before touching anything real.
- Manual `workflow_dispatch` against the real KB repo with exactly one due entry, to confirm the combined commit (markdown + registry bump) lands correctly and the deploy hook fires.
- Force a race: two manual dispatches back-to-back, confirm `withRegistryRetry` on the registry bump resolves cleanly rather than one run clobbering the other's `lastRefreshedAt` update.
