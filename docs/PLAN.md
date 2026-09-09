# ask-d2e: multi-repo Slack KB bot

## Context

ask-d2e is a Slack bot that lets an admin register any number of GitHub repos, has an interactive conversation with the admin to work out what each repo's knowledge base (KB) should cover, generates and continuously refreshes that KB from the real source code, and answers questions about it in Slack — with a thumbs-down feedback loop that re-reads the source and fixes the KB when an answer is wrong.

**Two repos, one deployment:**
- **`ask-d2e`** (this repo) — all application code: Slack handlers, GitHub Actions workflows, serverless functions, the marketing page. No KB content lives here. Deploys to **`https://ask-d2e.vercel.app/`**.
- **`ask-d2e-kb`** (`https://github.com/suwarnoong/ask-d2e-kb`, private, created — currently empty, no default branch yet) — pure content: `repos.json` (the registry of configured repos) + `repos/<name>/knowledge-base/**.md` per configured repo. Still needs its initial `repos.json` (`[]`) + README committed as the first implementation step (Phase 1) — not done as part of this planning session.

**Design decisions locked in:**
- **Claude access**: billed against a Claude Pro/Max subscription, not a pay-per-use API key — a `CLAUDE_CODE_OAUTH_TOKEN` (generated once via `claude setup-token`, valid ~1 year) is the credential every Claude call authenticates with. The Actions-side CLI wrapper (`callClaude`, used by initial-build/refresh/correct — see `docs/design/00-foundations.md`) requires it outright and has no fallback. The low-latency Q&A path (`answerQuestion`, direct Anthropic SDK — see `docs/design/03-qa-and-correction.md`) prefers it too, keeping a plain `ANTHROPIC_API_KEY` only as an optional escape hatch if no subscription token is configured.
- **Routing**: merge all configured repos' KBs into one system-prompt context for Q&A (no per-channel/per-repo routing). Citations read as `repos/<name>/<category>/<file>.md`, which is how a thumbs-down later figures out which source repo to check out for a correction.
- **Self-heal on uncovered questions**: when the bot honestly determines a question isn't covered, it doesn't just reply and stop — it classifies which configured repo (if any) plausibly covers it, and if one is found and not in cooldown, automatically dispatches the same correction workflow (in a new "gap-fill" mode) to explore the real source and add coverage if warranted, following up in-thread with the outcome. No admin click needed for this path (unlike a 👎 on an existing answer) since it's the bot's own determination, not a user claim — but it's cost-bounded by a cheap classification pre-filter and a per-repo cooldown so it can't spiral on out-of-scope or repeated questions. See `docs/design/03-qa-and-correction.md`.
- **Wizard state**: no external datastore — the admin's add-repo conversation lives entirely in Slack DM history; each bot reply carries a small machine-readable state blob so the next reply can pick up where it left off.
- **Priority order**: (1) multi-repo data model, (2) admin add-repo wizard, (3) multi-repo Q&A + vote-down/refresh, (4) generalized scheduled refresh, (5) admin remove-repo (low priority), (6) showcase page + branding pass.

## Target repo layout

```
ask-d2e/
├── src/
│   ├── shared/        config.ts, claude.ts, githubDiff.ts, slackBlocks.ts, types.ts
│   ├── kb/            registry.ts, kbFiles.ts, incrementalPrompt.ts, initialBuildPrompt.ts,
│   │                  correctionPrompt.ts, responseParsing.ts, gitOps.ts,
│   │                  refresh.ts, initialBuild.ts, correct.ts, removeRepo.ts
│   └── admin/wizard/  state.ts, steps.ts, addRepoWizard.ts, removeRepoFlow.ts
├── api/
│   ├── _lib/          thin shared modules for the serverless runtime (answer.ts, kb.ts, slack.ts, slackApi.ts)
│   ├── ask.ts          slash command (/ask)
│   ├── ask-admin.ts    admin slash command (/ask-admin add-repo|remove-repo)
│   ├── slack-events.ts    app_mention (Q&A) + gated message.im (wizard turns)
│   └── slack-interactions.ts  feedback buttons + wizard confirm/cancel + remove-repo confirm
├── scripts/build-kb-bundle.mjs   clones ask-d2e-kb into ./knowledge-base before function bundling
├── .github/workflows/  kb-refresh.yml, kb-initial-build.yml, kb-correct.yml, kb-remove-repo.yml
└── public/index.html
```

Each phase below has a companion detail doc under `docs/design/` with the concrete logic to build (data shapes, algorithms, prompts, workflow YAML) — this file stays the map; the design docs are the territory.

## Dependencies

```json
{
  "engines": { "node": ">=20" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.106.0",
    "@octokit/rest": "^21.0.2",
    "@vercel/functions": "^3.7.4",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@vercel/node": "^5.8.22",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
```

`@octokit/rest` is only used by the `src/` Actions scripts (`gatherRepoPrs`, checkout/PR-diff work) — the Vercel functions under `api/` deliberately never import it, calling the GitHub REST API with plain `fetch` instead (see `dispatchCorrection`-style calls in `docs/design/02-admin-wizard.md`/`docs/design/03-qa-and-correction.md`) to keep the deployed function bundles lean. `tsx` runs the Actions entrypoints directly from TypeScript (`npm run kb-refresh`, etc., mirroring the `npm run <task>` scripts named throughout the design docs) without a separate compile step.

## Cross-cutting design resolutions

1. **KB-repo mutations happen only through Actions, via git** — never through the GitHub Contents API from the request-handling side. The serverless functions only converse in Slack and end with a single `workflow_dispatch`; the dispatched Action does the actual clone → edit → commit → push. See [`docs/design/01-kb-data-model.md`](design/01-kb-data-model.md).

2. **`repos.json` needs a retry-safe mutation helper, not a textual rebase.** Two Actions racing to edit the same JSON array (two admins adding repos, or a refresh racing a correction) can produce a real conflict even on logically-independent edits. `withRegistryRetry(mutateFn)` fetches latest, re-reads, applies a pure mutation, writes, commits, pushes, and retries the whole cycle on a non-fast-forward push instead of `git rebase`. See [`docs/design/01-kb-data-model.md`](design/01-kb-data-model.md).

3. **Wizard gating: DM-based, not channel-wide.** The new Slack event subscription is `message.im` (needs `im:history` alongside `im:write`) rather than `message.channels`/`groups` — narrower scope ask, and "sender is admin" is nearly free to check in a 1:1 DM. See [`docs/design/02-admin-wizard.md`](design/02-admin-wizard.md).

4. **Wizard state lives in the bot's own last message, not an external store.** Each bot reply in the wizard DM carries a trailing machine-readable JSON blob. On a gated DM reply, the handler finds the latest bot message, extracts the blob, applies the new answer, computes the next step, posts the next message with an updated blob. See [`docs/design/02-admin-wizard.md`](design/02-admin-wizard.md).

5. **Correction repo-resolution is a genuinely new problem.** The Q&A system prompt must require citing the exact tagged path (`repos/<name>/...`) so a thumbs-down can be resolved. The correction flow first regexes the flagged answer for `repos/([^/]+)/`; if exactly one distinct name is found, resolve directly. If zero or multiple, fall back to a cheap classification call. Prototype this early (Phase 3). See [`docs/design/03-qa-and-correction.md`](design/03-qa-and-correction.md).

6. **Token/scope matrix** (a stated constraint, not solved generically):

   | Token | Scope needed | Used by |
   |---|---|---|
   | `KB_REPO_TOKEN` | contents:write on `ask-d2e-kb` | all KB-mutating Actions (checkout+push); the build step (read, to clone) |
   | `SOURCE_REPOS_TOKEN` | contents:read across all configured source repos | PR-diff gathering AND checkout in refresh (see risk #8 below); checkout in initial-build/correct |
   | `GITHUB_DISPATCH_TOKEN` | actions:write on `ask-d2e` | the wizard/feedback handler functions dispatching workflows |
   | `SLACK_BOT_TOKEN` | chat:write, im:write/history | both the serverless functions and Actions (threaded/DM replies) |

   Assumes one shared read PAT can see every configured source repo (same org/user) — no per-repo token selection is built now.

7. **Initial-build scope bounding.** A blind "explore everything" prompt against a large monorepo can run indefinitely. The initial-build prompt seeds a file-tree overview and the repo's own README(s) before Claude starts drilling with Read/Grep/Glob tools, injects the wizard's crafted focus areas as explicit priorities, and constrains output to a fixed category-folder convention. See [`docs/design/02-admin-wizard.md`](design/02-admin-wizard.md).

## Known deployment values (collected so far, not committed to code)

These are real, deployment-specific values to configure as env vars/secrets when each phase is implemented — never hardcoded into source:

- `KB_FEEDBACK_ADMIN_IDS`: `U0AEL63VB8B` (more admins may be added later — keep this a comma-separated list).

## Phases

1. **Multi-repo data model + KB repo layout + path-safety** — [`docs/design/01-kb-data-model.md`](design/01-kb-data-model.md)
2. **Admin add-repo wizard**, plus `set-cadence`/`edit-repo` for revising an already-configured repo — [`docs/design/02-admin-wizard.md`](design/02-admin-wizard.md)
3. **Multi-repo Q&A + vote-down/refresh** — [`docs/design/03-qa-and-correction.md`](design/03-qa-and-correction.md)
4. **Generalized scheduled refresh (single daily cron)** — [`docs/design/04-scheduled-refresh.md`](design/04-scheduled-refresh.md)
5. **Admin remove-repo (low priority)** — [`docs/design/05-remove-repo.md`](design/05-remove-repo.md)
6. **Deployment bundling/deploy-hook + showcase page + branding** — [`docs/design/06-deployment-showcase.md`](design/06-deployment-showcase.md)

## Open risks (flagged, not solved by this plan)

1. Correction repo-resolution is best-effort — citation parsing can fail on multi-repo or messy answers; the classification fallback adds latency, worth prototyping early.
2. GitHub Actions' `actions/checkout` can't take a dynamically-computed `repository:` input mid-job — the correction workflow needs a manual `git clone` step instead.
3. `withRegistryRetry` is a new concurrency pattern and needs real concurrent-dispatch testing, not just code review.
4. Initial-build scope bounding is a heuristic, not a solved algorithm, for very large source repos — consider a hard file/turn cap alongside the timeout.
5. DM-only wizard gating is a narrower scope than a full channel/group rollout — simpler and safer, flagging the trade explicitly.
6. Shared source-repo token assumes one org/owner — multi-org source repos are out of scope for now.
7. ~~Branding colors are unverified against the live data2evidence.org site~~ — **resolved**: verified via a live browser session. The navy primary was already an exact match; the accent hex was nudged to data2evidence.org's exact value, and the page's font stack was switched to the same system-font fallback their own site uses (their actual fonts are commercially licensed, not something to embed without a license). See `docs/design/06-deployment-showcase.md`, "Branding — verified against the live data2evidence.org."
8. The incremental refresh now clones every due repo each run (not just initial-build/correction) so Claude can verify ambiguous or diff-truncated changes against the real current file instead of trusting a capped/partial diff alone (see `docs/design/04-scheduled-refresh.md`, "Verifying against ground truth"). This adds a clone-per-due-repo cost to what was originally a checkout-free path — acceptable for correctness, but worth watching if the configured-repo count grows large enough to make the daily job noticeably slower.
9. **`https://ask-d2e.vercel.app/` is already live**, currently serving the existing single-repo showcase page/bot — this is a cutover of a production deployment, not a fresh launch. Needs: confirming which hosting project/connected repo currently owns the domain, verifying the new build on a separate preview deployment first, and a deliberate cutover only once at least one repo is fully onboarded and answering correctly through the new system (see `docs/design/06-deployment-showcase.md`, "The domain is already live").
