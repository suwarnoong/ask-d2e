# Foundations: shared config, Claude access, GitHub, Slack

These modules live in `src/shared/` (used by Actions entrypoints) with thin equivalents in `api/_lib/` (used by the serverless functions). Every later phase builds on these.

## Env-driven config loading (`src/shared/config.ts`)

A small set of parsing helpers, reused by every task-specific config loader:

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function parseWebhooks(raw: string): string[] {
  // Accept one URL or many, separated by commas and/or newlines.
  const urls = raw.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("Slack webhook setting must contain at least one URL.");
  return urls;
}

function positiveNumber(name: string, fallback: string): number {
  const value = Number(optional(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

/** Model for a specific task: task-specific env var → shared CLAUDE_MODEL → hardcoded fallback. */
function taskModel(taskEnv: string, fallback: string): string {
  return optional(taskEnv, optional("CLAUDE_MODEL", fallback));
}
```

Shapes:

```ts
interface ClaudeAuth { claudeOauthToken: string; claudeModel: string }
interface CommonConfig extends ClaudeAuth {
  slackWebhookUrls: string[];
  skipIfEmpty: boolean;
  tzLabel: string;
}
```

Task-specific configs (`RefreshConfig`, `InitialBuildConfig`, `CorrectConfig`, `RemoveRepoConfig`) extend `CommonConfig` and are **repo-scoped from the start** — they take a `repoName`/`sourceRepo` parameter rather than reading a single global env var the way a single-repo bot would. `loadXConfig()` functions read `KB_REPO_TOKEN`, `SOURCE_REPOS_TOKEN`, `KB_TARGET_BRANCH` (default `main`), `KB_DRY_RUN`, and per-task model overrides via `taskModel(...)` (e.g. `REFRESH_MODEL`/`INITIAL_BUILD_MODEL`/`CORRECT_MODEL`, all falling back to `CLAUDE_MODEL`, then a hardcoded default — heavier tasks like initial-build default to a stronger model than the cheap Q&A path).

## Claude CLI wrapper (`src/shared/claude.ts`)

Used by every Actions entrypoint that needs Claude to read real files (`Read`/`Grep`/`Glob`) and produce a structured plan. Not used by the Q&A path (that talks to the Anthropic SDK directly for lower latency — see `docs/design/03-qa-and-correction.md`).

```ts
interface CallClaudeOptions {
  cwd?: string;                 // working dir the CLI runs in, so file tools see this tree
  allowedTools?: string[];      // e.g. ["Read", "Grep", "Glob"] — auto-approved in headless mode
}

function callClaude(prompt: string, auth: ClaudeAuth, opts: CallClaudeOptions = {}): Promise<string> {
  // spawn: claude -p --output-format json --model <auth.claudeModel> [--allowedTools <opts.allowedTools.join(",")>]
  // cwd: opts.cwd; env: CLAUDE_CODE_OAUTH_TOKEN=auth.claudeOauthToken
  // feed `prompt` on stdin, close stdin
  // hard timeout from CLAUDE_TIMEOUT_MS (default 120_000ms) — SIGKILL + reject on expiry
  // on close: parse stdout as JSON, return the `.result` string field
  // reject on: missing token, non-zero exit code (include stderr), empty/unparseable result
}
```

Callers raise `CLAUDE_TIMEOUT_MS` per-workflow: the incremental refresh and initial-build jobs need much more headroom (10 minutes) than the default, since they feed large prompts and/or explore a checked-out repo with tools.

## GitHub PR-diff gathering (`src/shared/githubDiff.ts`)

```ts
async function gatherRepoPrs(sourceRepo: string, sinceIso: string, githubToken: string): Promise<DigestData>
```

Generalizes to take `sourceRepo` (`"owner/name"`) and `sinceIso` as parameters instead of reading a single global config:

- Octokit search: `repo:<sourceRepo> is:pr is:merged merged:>=<sinceIso>`, paginated, `advanced_search: "true"`.
- For each match, fetch the full PR (search results omit additions/deletions/changed_files).
- Guard: drop anything whose `merged_at` predates `since` (search granularity isn't exact).
- Per-PR diff: page through `pulls.listFiles`, build a text block per file (`### <status> <filename> (+adds/-dels)` + the patch, or a binary note if no patch), **cap total diff text at 24,000 chars per PR** — once the cap is hit, append `### …and N more file(s) not shown (diff size cap reached)` and stop; flag `diffTruncated: true`.
- Body excerpt: strip HTML comments (PR templates) and CRs, collapse to one line, cap at 280 chars with a trailing `…`.
- Group by author, sorted by PR count then total churn (additions+deletions), most active first.
- Return `{ repo, since, generatedAt, prs, byAuthor, totals: { prCount, authorCount, additions, deletions } }`.

This feeds both the incremental refresh prompt (Phase 4) and, indirectly, is *not* used for the initial full build (Phase 2), which explores the whole repo instead of a PR window.

## Slack Block Kit + formatting (`src/shared/slackBlocks.ts`)

A `Block` union (`header`/`section`/`context`/`divider`/`actions`) plus:

- **`chunkText(text, limit = 2900)`** — Slack section blocks cap mrkdwn at 3000 chars; split on line boundaries under the limit, hard-splitting any single oversized line as a last resort.
- **`toSlackMrkdwn(md)`** — converts GitHub-Markdown (which the model still emits despite instructions) to Slack mrkdwn:
  - Split on fenced ` ``` ` blocks first so code is never rewritten.
  - GFM tables (a header row + a `|---|---|`-style delimiter row + body rows) → rendered as a padded, aligned fenced code block (Slack mrkdwn has no native tables).
  - `# Heading` (any level) → `*Heading*` (bold line, no headings in Slack mrkdwn).
  - `**bold**`/`__bold__` → `*bold*`; `~~strike~~` → `~strike~`; `[text](url)` → `<url|text>`.
  - Inline `` `code` `` spans are protected from all of the above.
- **`headerDate(iso, timeZone)`** — `Intl.DateTimeFormat("en-US", { weekday:"long", month:"short", day:"numeric", timeZone })`, falling back to UTC if the timezone label is invalid.
- **`postBlocks(webhookUrls, blocks, fallbackText)`** — POSTs to every configured incoming webhook via `Promise.allSettled`; one broken subscriber doesn't block the rest; throws only if *all* fail; masks the webhook path in logs (`services/***`).
- **`postThreadReply({ botToken, channel, thread_ts, blocks, fallbackText })`** — `chat.postMessage` with a bot token so a notice can land **inside** a specific thread (an incoming webhook can only post standalone to its bound channel) — this is what lets a KB-correction notice reply directly under the flagged answer.

## Slack request verification + admin allowlist (`src/shared/slackAuth.ts`, shared by the serverless functions + used conceptually by Actions dispatch validation)

```ts
function verifySlackSignature(rawBody: string, signature: string|null, timestamp: string|null, signingSecret: string): boolean {
  // reject if signature/timestamp missing, or |now - timestamp| > 300s (replay protection)
  // expected = "v0=" + HMACSHA256(signingSecret, `v0:${timestamp}:${rawBody}`).hex()
  // constant-time compare (crypto.timingSafeEqual) — return false on any length mismatch
}

function adminIds(): Set<string> {
  return new Set((process.env.KB_FEEDBACK_ADMIN_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean));
}
function isAdmin(userId?: string): boolean {
  return Boolean(userId) && adminIds().has(userId);
}
```

`isAdmin` gates: seeing feedback buttons at all, whether a 👎 actually triggers a correction vs. just being logged, and (new in this build) whether a DM reply is treated as a wizard turn at all.

`friendlyError(err)` turns a 429/529/5xx into "The AI service is busy right now — please try again in a moment" instead of leaking raw error text to Slack.

## Slack Web API helpers (`api/_lib/slackApi.ts`)

Used by the Events API and the wizard (both need a bot token, unlike slash commands which reply via a one-off `response_url`):

- **`postMessage({ channel, text, blocks, thread_ts? })`** → `chat.postMessage`.
- **`openDm(userId)`** → `conversations.open`, returns the DM channel id.
- **`getThreadReplies(channel, thread_ts, botUserId?, excludeTs?)`** → `conversations.replies` (limit 50), mapped to `Turn[]`: messages from the bot (by `bot_id` or matching `botUserId`) become `{ role: "assistant" }`, everything else becomes `{ role: "user" }` with any `<@BOTID>` mention stripped; system-subtype messages (joins, edits) are skipped; `excludeTs` drops the just-received message so it isn't double-counted.
- **`getBotUserId()`** → `auth.test`, cached per invocation.
- **`stripMention(text, botUserId?)`** → strips `<@BOTID>` (or any `<@[A-Z0-9]+>` if `botUserId` is unknown).

This is the exact mechanism the Q&A follow-up flow already needs (Phase 3) and the wizard (Phase 2) reuses directly for its own conversational state — see `docs/design/02-admin-wizard.md` cross-reference #4.
