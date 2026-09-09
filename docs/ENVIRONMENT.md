# Environment & secrets checklist

Everything below is a real value you'll need to obtain/generate and paste into one of three
places once the corresponding phase is implemented — **nothing here is created by writing code,
and none of it should ever be committed to the repo**. This is a preparation checklist, not a
`.env` file to fill in today (the backend doesn't exist yet — see `docs/PLAN.md`).

## Where things live

| Surface | What goes there | Who reads it |
|---|---|---|
| **Slack app config** (api.slack.com/apps) | Signing secret, bot token, event subscriptions, scopes | Not an env var — configured in the Slack UI itself |
| **Vercel project → Environment Variables** | Everything the serverless functions (`/api/*`) and the build step need at request/build time | `api/ask.ts`, `api/slack-events.ts`, `api/slack-interactions.ts`, `scripts/build-kb-bundle.mjs` |
| **GitHub → `ask-d2e` → Settings → Secrets and variables → Actions** | Everything the scheduled/dispatched workflows need | `kb-refresh.yml`, `kb-initial-build.yml`, `kb-correct.yml`, `kb-remove-repo.yml` |

Split into **Secrets** (never shown again after saving — tokens, keys) vs **Variables** (plain
text, fine to be visible — repo names, branch names) on the GitHub side; Vercel doesn't
distinguish the two.

## 1. Slack app credentials

| Name | Required | Where | How to get it |
|---|---|---|---|
| `SLACK_SIGNING_SECRET` | yes | Vercel env var | Slack app → **Basic Information → App Credentials** |
| `SLACK_BOT_TOKEN` | yes | Vercel env var **and** GitHub Actions secret | Slack app → **OAuth & Permissions**, the `xoxb-…` token, after installing the app to the workspace. Needed in both places: Vercel posts `@mention`/DM/wizard replies; Actions posts threaded correction notices (`docs/design/03-qa-and-correction.md`) |

Scopes the Slack app manifest needs (see `docs/design/06-deployment-showcase.md` and
`docs/design/02-admin-wizard.md`): `commands`, `app_mentions:read`, `chat:write`, `im:write`,
`im:history` (new, for the admin wizard), `channels:history`. Event subscriptions: `app_mention`,
`message.im` (new). These are configured in the Slack app manifest itself, not as env vars.

## 2. Claude access — subscription-based (confirmed decision, see `docs/PLAN.md`)

| Name | Required | Where | How to get it |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | Vercel env var **and** GitHub Actions secret | Run `claude setup-token` once on a machine logged into a Claude Pro/Max subscription; copy the printed token (valid ~1 year). Needed everywhere Claude is called — the Q&A path (Vercel) and every KB-mutating workflow (Actions), which requires it outright with no fallback (`docs/design/00-foundations.md`) |
| `ANTHROPIC_API_KEY` | optional | Vercel env var only | Only relevant as an escape-hatch fallback for the Q&A path if no subscription token is configured — not used by the Actions CLI wrapper at all |

Optional per-task model overrides (all fall back to `CLAUDE_MODEL`, then a hardcoded default —
skip unless you want a specific model per task): `CLAUDE_MODEL`, `ANSWER_MODEL` (Vercel),
`REFRESH_MODEL`, `INITIAL_BUILD_MODEL`, `CORRECT_MODEL` (GitHub Actions variables).

## 3. GitHub Personal Access Tokens

| Name | Required | Where | Scope needed |
|---|---|---|---|
| `KB_REPO_TOKEN` | yes | GitHub Actions secret **and** Vercel env var | `contents:write` on `suwarnoong/ask-d2e-kb` (Actions checkout+push all KB edits; Vercel only needs read to clone at build time, but reusing one write-scoped token is simplest unless you'd rather mint a read-only one for Vercel specifically) |
| `SOURCE_REPOS_TOKEN` | yes, once any repo is onboarded | GitHub Actions secret only | `contents:read` across **every** configured source repo. Assumes one token can see them all (same org/user) — a stated constraint, not solved generically (`docs/PLAN.md` open risk #6) |
| `GITHUB_DISPATCH_TOKEN` | yes | Vercel env var only | `actions:write` on `ask-d2e` — lets the wizard/feedback handlers dispatch `kb-initial-build.yml`/`kb-correct.yml`/`kb-remove-repo.yml` |

`GITHUB_TOKEN` is auto-provided inside every Actions run — no setup needed, and it's not
sufficient on its own for anything cross-repo (that's what the PATs above are for).

## 4. KB repo & registry config

| Name | Required | Where | Notes |
|---|---|---|---|
| `KB_REPO` | yes | Vercel env var, GitHub Actions variable | `suwarnoong/ask-d2e-kb` |
| `KB_BRANCH` | no (default `main`) | Vercel env var | Branch the build step clones from |
| `KB_TARGET_BRANCH` | no (default `main`) | GitHub Actions variable | Branch Actions push KB edits to — set to an unprotected branch if `main` blocks direct pushes |

## 5. Admin allowlist

| Name | Required | Where | Value |
|---|---|---|---|
| `KB_FEEDBACK_ADMIN_IDS` | yes | Vercel env var only (checked in the interactions/events handlers before anything is dispatched) | Comma-separated Slack user IDs. Known so far: **`U0AEL63VB8B`** — append more as they're identified |

## 6. Deploy hook

| Name | Required | Where | How to get it |
|---|---|---|---|
| `DEPLOY_HOOK_URL` | yes, once Phase 6's Actions wiring exists | GitHub Actions secret | Vercel project → **Settings → Git → Deploy Hooks** — create one, name it, copy the URL. Curled at the end of every KB-mutating workflow so the live site picks up KB changes automatically (`docs/design/06-deployment-showcase.md`) |

## 7. Optional / dev-only

| Name | Default | Purpose |
|---|---|---|
| `KB_DRY_RUN` | `false` | Local-only flag — writes files, prints the would-be registry mutation, skips commit/push/dispatch. Never set in a deployed environment. |
| `CLAUDE_TIMEOUT_MS` | 120000 (2 min) | Each workflow overrides this higher (refresh/correct: 10 min; initial-build: 15 min — see `docs/design/02-admin-wizard.md`) |
| `ANSWER_MAX_RETRIES` | 5 | Vercel env var, Q&A path only — retry budget for transient 429/529/5xx from the Claude API |

## What's already confirmed vs. still to be created

- ✅ `ask-d2e-kb` repo exists (private, empty — needs its initial `repos.json` + README as the first Phase 1 step).
- ✅ Deployment domain: `https://ask-d2e.vercel.app/` (already live, currently serving the old single-repo page — see the cutover notes in `docs/design/06-deployment-showcase.md`).
- ✅ First admin ID: `U0AEL63VB8B`.
- ⬜ Everything else above — PATs, the Slack bot token, the Claude subscription token, and the deploy hook — still needs to be generated/created when we get to the phase that first needs it. I'll flag exactly which one(s) are needed at the start of each implementation phase rather than asking for everything up front.
