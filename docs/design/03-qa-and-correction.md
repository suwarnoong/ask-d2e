# Phase 3: Multi-repo Q&A + vote-down/refresh

## Answer engine (`api/_lib/answer.ts`)

**Runtime KB access**: at build time (see `docs/design/06-deployment-showcase.md`), `ask-d2e-kb` is cloned into `./knowledge-base`, so at request time the function reads a **local, already-bundled** folder — no runtime GitHub calls, no vector DB. The whole merged KB is small enough to fit in the model's context and gets cached as part of the system prompt.

```ts
function readAllRepoKbs(root = process.cwd()): KbFile[] {
  // walk knowledge-base/repos/*/knowledge-base/**/*.md
  // path stays "repos/<name>/<category>/<file>.md" relative to root — this exact string
  // is what later shows up in citations and is what correction repo-resolution parses.
}

function renderKbForPrompt(files: KbFile[]): string {
  // 1. A short index first: for each configured repo (read repos.json's name/audience/
  //    sourceRepo — NOT the promptSpec internals, just enough for the model to answer
  //    meta-questions like "what do you know about?" or "which repos are configured?").
  // 2. Then the full file dump: "===== FILE: <path> =====\n<content>" per file, OR — if
  //    the combined size crosses a budget (see below) — a path + first-heading index only,
  //    so N repos' worth of KB can't silently blow out the prompt.
}
```

The single-repo `KB_CONTENT_BUDGET` (600,000 chars) scales with the number of configured repos — recompute it as e.g. `max(600_000, 150_000 * repoCount)` or similar, and log a warning whenever the index-only fallback triggers so growth is visible before it becomes a real problem.

Cache the rendered KB across warm serverless invocations exactly as today (a module-level variable populated on first use per cold start).

### System prompt construction

```ts
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."; // required
  // first system block ONLY when authenticating via the Claude Code subscription OAuth
  // token (CLAUDE_CODE_OAUTH_TOKEN) rather than a plain ANTHROPIC_API_KEY.

const NO_KB_MATCH = "NO_KB_MATCH"; // sentinel the model prepends when nothing covers the question

const INSTRUCTIONS = `
You are ask-d2e, a Q&A assistant. Answer using ONLY the knowledge base provided.
Rules:
- Ground every claim in the knowledge base. If uncovered, say so plainly rather than guessing.
- When uncovered, begin your reply with ${NO_KB_MATCH} on its own first line, then the plain message.
- Be concise — this is a Slack reply.
- Cite the EXACT source path(s) you used at the end, formatted exactly as they appear
  (e.g. "repos/acme-widgets/03-cloud-functions/query-generation-service.md") — this exact
  string is later parsed to resolve which repo a correction should target, so do not
  paraphrase or shorten it.
Slack formatting (Slack mrkdwn, NOT GitHub Markdown): *single asterisks* for bold, no #
headings, no **double asterisks**; backticks for code; • for bullets.
`;
```

Client construction (`makeClient()`): prefer `CLAUDE_CODE_OAUTH_TOKEN` (sent as `Authorization: Bearer`, with `anthropic-beta: oauth-2025-04-20` header, `maxRetries` from `ANSWER_MAX_RETRIES` env, default 5 — high enough that a brief 429/529 capacity blip doesn't surface as a user-facing failure within the ~60s function budget); fall back to a plain `ANTHROPIC_API_KEY` client. Throw clearly if neither is set.

```ts
interface Turn { role: "user" | "assistant"; text: string }
interface AnswerResult { text: string; covered: boolean }

async function answerQuestion(question: string, history: Turn[] = []): Promise<AnswerResult> {
  // system = [ (oauth ? [CLAUDE_CODE_IDENTITY] : []), INSTRUCTIONS, { text: kbText(), cache_control: {type:"ephemeral"} } ]
  // messages = [...history, { role: "user", content: question }]
  // strip a leading NO_KB_MATCH sentinel from the reply text before returning; covered = !startsWith(sentinel)
}
```

## Slash command (`api/ask.ts`, e.g. `/ask`)

```
1. Verify Slack signature over the raw body.
2. Parse: text (question), response_url, command, user_id from the urlencoded body.
3. If no question text: reply with usage help.
4. Ack immediately (must respond within 3s) with an ephemeral "looking that up" message,
   picking one of several playful phrasings (optionally seeded by a hash of the question
   so retries/tests are deterministic).
5. In the background (after the ack): answerQuestion(question) → build answer Block Kit
   (question echoed, chunked answer body, footer, and 👍/👎 feedback buttons — shown to
   EVERY asker now, not just admins; see "Who can vote, who can trigger a fix" below —
   with the question packed into the button `value`, capped ~1900 chars since Slack caps
   button values at 2000) → POST to response_url.
6. If NOT covered: kick off the self-heal flow (see "Self-heal on uncovered answers" below)
   instead of just returning the plain "doesn't cover that" reply as final.
7. On error: friendlyError(err) posted to response_url as an ephemeral message.
```

## Events API (`api/slack-events.ts`, `@mention`)

```
1. Verify signature; handle the one-time url_verification handshake by echoing `challenge`.
2. Slack retries un-acked events — if `x-slack-retry-num` header is present, ack immediately
   and do nothing else (avoid answering the same question twice).
3. Ignore events from the bot itself or with no channel (self-loop guard).
4. Only handle event.type === "app_mention" for Q&A (a separate branch handles event.type ===
   "message" with channel_type "im" for the admin wizard — see 02-admin-wizard.md; the two
   must not collide, since a DM could theoretically also be an app_mention in principle but
   in practice DMs don't need an @mention to reach the bot).
5. Strip the mention from event.text to get the question; reply in the existing thread
   (event.thread_ts) or start a new one on the mention itself (event.thread_ts ?? event.ts).
6. If this is a follow-up in an existing thread (event.thread_ts !== event.ts): fetch prior
   turns via getThreadReplies(channel, thread_ts, botUserId, excludeTs=event.ts) BEFORE
   posting anything, so the ack isn't mistaken for a prior turn.
7. Post a "looking it up" ack in-thread; call answerQuestion(question, history); post the
   final answer with feedback buttons (shown to every asker now, same as the slash command).
8. If NOT covered: kick off the self-heal flow (see "Self-heal on uncovered answers" below) —
   this replaces the old "DM admins and stop" behavior; the DM-to-admins now only happens as
   self-heal's own fallback (no plausible repo, cooldown active, or exploration found nothing),
   not as the immediate reaction to every miss.
9. On error: post a friendly error message in-thread (never let a posting failure itself throw
   past the handler).
```

## Self-heal on uncovered answers (bot-initiated, no admin click needed)

This is a **third path**, distinct from both halves of "Who can vote, who can trigger a fix"
below — it isn't a user *claim* that something is wrong (which needs trust-gating), it's the
bot's own honest determination that nothing covers the question. That's a fact the model itself
computed from the full KB, not something a bad-faith click could fake, so it doesn't need the
same admin approval gate the 👎-on-existing-answer path does. What it DOES need is protection
against wasting compute on questions that were never answerable from any configured repo, and
against repeatedly re-exploring the same gap — hence the two checks below before anything
expensive happens.

Triggered from both the slash command and the events handler, whenever `answerQuestion` returns
`covered: false`:

```
1. Cheap classification first (no checkout, no tool use, no full KB bodies — just the registry's
   per-repo name/audience/focusAreas, same lightweight metadata used for "which repo does this
   answer's citation belong to" in Correction repo-resolution below — this reuses that same
   classifier function, just invoked proactively here instead of only as a fallback):
   "Given this question and these configured repos' audience/focus descriptions, which ONE (if
   any) plausibly covers it? Respond with a name or null."
2. If null (no plausible repo) → skip straight to step 5 (inform user + DM admins) — there's
   nothing to explore; a human needs to decide whether this is in scope at all.
3. If a repo is found, check its cooldown: canAutoRefresh(entry, now) — false if
   entry.lastAutoRefreshAt is within the cooldown window (e.g. 1 hour; see
   docs/design/01-kb-data-model.md). If cooling down → skip straight to step 5, so a burst of
   similar misses degrades to "logged for a human" instead of firing duplicate jobs.
4. Otherwise: reply in-thread immediately with an honest interim message ("The knowledge base
   doesn't cover that yet — let me check the source and get back to you."), then dispatch
   kb-correct.yml with mode: "gap-fill" (see Correction flow below), repo_name = the classified
   repo, question, answer = the interim message text, slack_channel/slack_thread_ts so the
   follow-up lands in the same thread, and withRegistryRetry to bump lastAutoRefreshAt = now
   for that entry (spend the cooldown budget on the attempt, whether or not it succeeds).
5. Fallback (reached from steps 2, 3, or from the workflow itself finding nothing — see
   Correction flow): DM every configured admin (same Promise.allSettled mechanism as the
   original gap-alert) with the question, asker, and the honest reply; log it either way.
```

Because exploring a real codebase takes minutes, not seconds, this can never be synchronous
within a single Slack response — step 4's interim reply IS the response; the eventual outcome
(found something and updated the KB, or still nothing) arrives as a **follow-up message in the
same thread** once `kb-correct.yml` finishes, reusing the exact `postThreadReply`
notice mechanism the wrong-answer correction path already uses (see `correct.ts` below) — no new
delivery mechanism, just a new trigger and a new prompt variant.

## Who can vote, who can trigger a fix

Two separate gates, easy to conflate:

- **Visibility (who sees the 👍/👎 buttons at all): everyone.** Every answer — slash command or
  @mention, asked by anyone — carries feedback buttons. The original single-repo design showed
  buttons only when the ASKER was an admin, which meant regular users (the majority of traffic)
  could never flag a wrong answer at all. That's changed: showing buttons to everyone is what
  makes "vote-down" an actual user-facing feature rather than an admin self-review tool.
- **Trigger (who can cause an automatic re-check/fix): admins only.** Dispatching the correction
  workflow checks out real source, calls Claude, and commits to the KB — that stays trust-gated
  regardless of who can see the button, both to control cost (a GitHub Actions job + LLM call per
  click) and to keep unreviewed content changes from a bad-faith or mistaken click. A non-admin's
  👎 is never silently dropped, though — it's logged AND proactively escalated to every configured
  admin via DM (mirroring the existing "couldn't answer" gap-alert — see step 8 above), carrying
  the same 👎 button so an admin can approve the fix in one click instead of digging through logs.

This means the blast radius of a non-admin (or bad-faith) 👎 is bounded either way: at worst it's
noise in an admin's DMs, never a KB mutation nobody reviewed — the correction is always grounded
in re-reading the real source, not in trusting the flag itself, so even an admin approving a bogus
flag just gets back "reviewed, no change needed" rather than a wrong edit.

## Interactions endpoint (`api/slack-interactions.ts`, button clicks)

```
1. Verify signature.
2. Parse the urlencoded `payload` field (Slack sends block_actions payloads this way, not as JSON body).
3. Only handle payload.type === "block_actions"; extract the first action, response_url, user id,
   the packed question (action.value), and — by reconstructing from the flagged message's
   `section` blocks — the answer text that was actually shown to the user.
4. Also capture channel id + thread_ts from the flagged message, so a correction notice can
   later reply in the SAME thread the bad answer appeared in.
5. Ack fast (background work happens after returning 200):
   - 👍 → ephemeral "thanks!" (from anyone — no gating, never mutates anything, not logged;
     see "Who can vote, who can trigger a fix" above).
   - 👎 from a non-admin → log it ("KB feedback (down) from <user>: <question>"), DM every
     configured admin (Promise.allSettled — same mechanism as the unanswered-question gap
     alert, just a different reason/copy: "flagged as wrong" vs. "couldn't answer") carrying
     the question, flagged answer, and asker, with the same 👎 button so an admin can approve
     the fix from the DM itself, and reply ephemeral "logged for review" to the person who
     clicked — never mutates the KB directly.
   - 👎 from an admin → resolve which configured repo this concerns (see below), then dispatch
     kb-correct.yml via REST workflow_dispatch (same mechanism as the wizard's dispatch —
     see 02-admin-wizard.md), passing question/answer/asked_by/slack_channel/slack_thread_ts
     (each truncated to fit GitHub's 1024-char input cap) plus the resolved repo_name (best-effort
     — the Action re-verifies rather than trusting this blindly, since Slack input isn't
     validated server-side the same way). Ephemeral "on it" reply.
6. On error: ephemeral "couldn't start the KB update: <message>" reply (best-effort, swallow
   secondary failures so the handler itself never throws).
```

## Correction repo-resolution (new — no single-repo bot ever needed this)

Two call sites share one classifier: resolving which repo a **flagged existing answer** concerns
(citation-based, below), and resolving which repo an **uncovered question** might concern
(no citation to parse — self-heal above calls the classification step directly).

```ts
function resolveRepoFromCitation(answerText: string): string | null {
  const names = [...new Set([...answerText.matchAll(/repos\/([^/\s]+)\//g)].map(m => m[1]))];
  return names.length === 1 ? names[0] : null;
}

async function classifyRepoForQuestion(question: string, registry: RegistryEntry[]): Promise<string | null> {
  // Cheap Claude call: registry names + audience + focusAreas only (no KB bodies, no tools) +
  // the question; ask "which ONE of these configured repos does this concern? Respond with a
  // name, or the literal string 'none'." Used both as the citation fallback below AND as the
  // primary (only) resolution step for self-heal, since an uncovered question has no citation.
}
```

For a **flagged existing answer**: try `resolveRepoFromCitation` first (cheap, no LLM call); if it
returns `null` (zero or multiple distinct repo names cited — the model didn't cite cleanly, or
the answer legitimately spans repos), fall back to `classifyRepoForQuestion`. This is a genuinely
new failure mode worth prototyping early.

For an **uncovered question** (self-heal): there's no citation to try first, so go straight to
`classifyRepoForQuestion` — a `null` result means "no configured repo plausibly covers this,"
which self-heal treats as an immediate fallback to the admin DM (see above), not an error.

## Correction flow (`src/kb/correctionPrompt.ts`, `src/kb/correct.ts`)

Two prompt variants, selected by `mode`, since the two triggers have very different starting points:

- **`mode: "fix"`** (a 👎 on an existing answer — there's a specific citation pointing at what to
  re-check, so the search is naturally bounded):

  ```
  "You maintain a Markdown knowledge base documenting <sourceRepo>. A user asked ask-d2e a
  question; the bot answered FROM THE KB; the user marked the answer WRONG or incomplete.
  Find out what's actually true by reading the real source (checked out at <srcDir>) using
  Read/Grep/Glob, then fix the KB page(s) whose content produced the bad answer. Ground the
  correction in the code, NOT the existing KB wording (which is what misled the answer).
  Preserve each file's structure/tone; only correct what the code contradicts. If, after
  checking, the original answer was actually correct, return an EMPTY changes array explaining
  why — do not invent edits."
  ```

- **`mode: "gap-fill"`** (self-heal on an uncovered question — no citation to start from, so this
  needs the SAME scope-bounding technique as the initial full build, not an open-ended "just
  explore": seed a file-tree overview + the repo's own README(s) before Claude starts drilling
  with tools, per `docs/design/02-admin-wizard.md`'s initial-build prompt):

  ```
  "You maintain a Markdown knowledge base documenting <sourceRepo>. A user asked ask-d2e a
  question the current KB doesn't cover. Using the file-tree overview and README(s) below as a
  starting map, explore the real source (checked out at <srcDir>) with Read/Grep/Glob to find
  out if this is something the KB should document. If you find a real, substantial answer,
  create or update the appropriate page(s) under the existing category convention. If the
  question turns out to be out of scope for this repo, or you can't find enough to write a
  grounded page, return an EMPTY changes array explaining why — do not invent a page just to
  have something to show."
  ```

Both output the same `KbPlan` JSON shape as every other KB-writing prompt.

`correct.ts` entrypoint:

```
1. Read mode, question, answer, resolved repo_name from env (workflow_dispatch inputs).
2. Load that repo's KB (readRepoKb).
3. Build the mode-appropriate prompt; callClaude(prompt, auth, { cwd: <checkout root>,
   allowedTools: ["Read","Grep","Glob"] }).
4. parseKbResponse. If plan.changes is empty:
   - mode "fix" → post a Slack notice ("reviewed, no change needed: <summary>") and stop.
   - mode "gap-fill" → post the "still not covered" follow-up in the original thread (if
     slack_channel/thread_ts available) AND DM every configured admin (self-heal's fallback —
     see "Self-heal on uncovered answers" above), then stop.
5. applyKbChanges, commitAndPush (subject: "docs(kb): correct answer flagged in Slack" for
   mode "fix", "docs(kb): fill gap found via Slack question" for mode "gap-fill").
6. Notify: if slack_channel + slack_thread_ts + SLACK_BOT_TOKEN are all present, postThreadReply
   so the notice lands directly under the flagged answer/original question; on any failure (or
   if those aren't available — e.g. a 👎 on an ephemeral slash-command reply with no real
   thread), fall back to postBlocks on the KB webhook as a standalone message. For mode
   "gap-fill", the notice includes plan.summary as a quick preview of what was found, plus a
   note that the live bot needs the redeploy (triggered by the deploy hook in the same run) to
   fully reflect it. Failure to notify is non-fatal — the KB was already updated regardless of
   whether Slack heard about it.
```

## Workflow: `.github/workflows/kb-correct.yml`

Needs to check out **whichever source repo the resolved entry names**, which is data-dependent (unknown at workflow-authoring time) — GitHub Actions' native `actions/checkout` action cannot take a `repository:` input computed from an earlier step in the same job. Use a manual script step instead:

```yaml
on:
  workflow_dispatch:
    inputs:
      mode: {required: true}            # "fix" (👎 on an existing answer) or "gap-fill" (self-heal)
      repo_name: {required: true}       # resolved (best-effort) by the request-handling side
      question: {required: true}
      answer: {required: false, default: ""}
      asked_by: {required: false, default: ""}
      slack_channel: {required: false, default: ""}
      slack_thread_ts: {required: false, default: ""}

permissions:
  contents: write

jobs:
  correct:
    steps:
      - checkout ask-d2e (code)
      - checkout ask-d2e-kb into ./kb (KB_REPO_TOKEN)
      - name: Resolve source repo and re-verify repo_name
        run: |
          # read ./kb/repos.json, look up repo_name -> sourceRepo; if repo_name from the
          # dispatch input doesn't exist in the registry, fail loudly rather than guessing.
      - name: Clone the resolved source repo
        run: git clone --depth 1 https://x-access-token:${SOURCE_REPOS_TOKEN}@github.com/${SOURCE_REPO}.git src-checkout
      - setup-node, npm ci, npm i -g @anthropic-ai/claude-code
      - run npm run kb-correct
        env: ..., CLAUDE_TIMEOUT_MS: "600000"
```

## Verification

- `npm run typecheck:api`.
- A local script that renders the merged multi-repo KB and logs its total size against the scaled budget, using ≥2 fixture repos, to confirm the index-only fallback triggers correctly when forced over budget.
- Manually exercise `/ask` and `@mention` in a test channel with ≥2 configured repos; confirm citations come back in the exact `repos/<name>/...` format; trigger a synthetic 👎 and confirm `resolveRepoFromCitation` picks the right repo (and confirm the classification fallback works when a fixture answer cites two repos at once).
- Ask something genuinely out of scope for every configured repo and confirm `classifyRepoForQuestion` returns `null` and the flow falls straight to the admin DM without dispatching a job.
- Ask something plausibly in-scope but not yet documented and confirm the interim "checking the source" reply posts immediately, `kb-correct.yml` runs in `gap-fill` mode, and the in-thread follow-up matches the outcome (found + KB updated, or still not covered + admin DM).
- Ask the same uncovered question twice in quick succession and confirm the second one skips straight to the admin DM (cooldown active) instead of dispatching a second job.
