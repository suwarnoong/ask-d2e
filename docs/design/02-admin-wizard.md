# Phase 2: Admin add-repo wizard

## Entry point

The dedicated `/ask-admin` slash command (`api/ask-admin.ts` — see `docs/design/06-deployment-showcase.md`) starts the flow: `/ask-admin add-repo owner/name`. The handler:

1. Checks `isAdmin(userId)` **first, before looking at what they typed at all.** A non-admin gets
   a friendly ephemeral reply regardless of whether their instruction was valid or garbage —
   e.g. "Admin actions are limited to the ask-d2e admin team — ping one of them if you need a
   repo added or removed." Never shows the list of subcommands to a non-admin, and never
   proceeds to parsing.
2. For an admin, parse the subcommand: `add-repo owner/name`, `remove-repo <name>` (see
   `docs/design/05-remove-repo.md`), `set-cadence <name> daily|weekly`, `edit-repo <name>` (both
   below). Anything else — no args, a typo, an unrecognized subcommand — gets an ephemeral
   usage-help reply listing exactly what's available, e.g.:
   ```
   Available:
   • /ask-admin add-repo owner/name — onboard a new repo
   • /ask-admin remove-repo <name> — remove a configured repo
   • /ask-admin set-cadence <name> daily|weekly — change how often a repo refreshes
   • /ask-admin edit-repo <name> — revise a repo's audience/focus areas
   ```
3. For `add-repo` or `edit-repo`: opens (or reuses) a DM with the admin (`openDm(userId)`).
4. Posts the first wizard question there, seeded with an initial state blob (see below).

All subsequent turns happen as plain DM replies — no need to re-invoke a command each time.

## Wizard state: carried in the bot's own last message

There is no external datastore. Each bot message in the wizard DM ends with a trailing, human-invisible-ish line encoding the conversation's current state as JSON, e.g.:

```
What audience is this knowledge base for — internal engineers, external customers, support, all of the above?

ASK_D2E_WIZARD_STATE: {"active":true,"step":"audience","sourceRepo":"acme/widgets","answers":{}}
```

On a new DM message from an admin:

1. Gate: is the sender an admin, and is this a DM (not a channel message)?
2. Fetch the thread/DM history (`getThreadReplies`-equivalent for a DM channel — DMs don't have Slack "threads" in the channel sense, so this reads the last N messages of the DM channel via `conversations.history` instead of `conversations.replies`).
3. Find the **most recent bot message** in that history; regex out the `ASK_D2E_WIZARD_STATE: {...}` trailing blob.
4. If no active state is found (`active` missing/false), ignore the message — it's not a wizard turn.
5. Otherwise, apply the admin's plain-text reply as the answer to the current `step`, advance to the next step, and post the next question with an updated state blob appended.

No TTL/cleanup needed — an abandoned wizard simply never advances past its last message; a fresh `add-repo` command elsewhere overwrites nothing (each DM channel only ever has one "latest bot message," so only the most recent invocation matters).

## Steps

```
1. sourceRepo      — provided at kickoff (from the command args), confirmed back to the admin
2. audience        — freeform: "who is this KB for?"
3. exampleQuestions — freeform, 2-3 examples the admin wants answerable
4. focusAreas      — freeform: "anything specific it should prioritize covering?"
5. cadence         — "daily" or "weekly" (default weekly if the admin doesn't care)
6. crafting        — no admin input; the bot makes one direct Anthropic API call (same
                      client-construction pattern as the Q&A path — see 03-qa-and-correction.md
                      — NOT the CLI wrapper, since this call doesn't need file tools) that turns
                      the freeform answers into a structured PromptSpec: audience (cleaned up),
                      exampleQuestions (list), focusAreas (list), scopeNotes (anything the admin
                      implied should be excluded). Posts a summary + a Yes/No confirmation.
7. confirmed       — Yes → dispatch kb-initial-build.yml (below); No → admin can restate any
                      answer in plain text ("actually the audience is also external partners")
                      and the bot re-crafts and re-confirms.
```

Each step's prompt should give the admin an easy escape hatch ("say 'cancel' to stop") which just marks `active: false` in the next state blob without dispatching anything.

## Confirm → dispatch

On Yes, the wizard handler does a REST `POST` to:

```
https://api.github.com/repos/<owner>/ask-d2e/actions/workflows/kb-initial-build.yml/dispatches
Authorization: Bearer <GITHUB_DISPATCH_TOKEN>
Accept: application/vnd.github+json

{
  "ref": "main",
  "inputs": {
    "repo_name": "...",
    "source_repo": "owner/name",
    "prompt_spec_json": "...",   // JSON.stringify(promptSpec), truncated to fit GitHub's 1024-char-per-input cap
    "cadence": "daily|weekly",
    "created_by": "<slack user id>"
  }
}
```

(GitHub caps each `workflow_dispatch` input at 1024 chars — if a crafted `PromptSpec` risks exceeding that once stringified, trim `exampleQuestions`/`focusAreas` to the most essential few during the crafting step rather than truncating mid-JSON.)

Post an ephemeral-style DM reply acknowledging the dispatch ("On it — building the initial knowledge base for `owner/name`, I'll let you know when it's ready").

## Editing an already-configured repo

Without this, the only way to change one setting on an existing repo would be to remove it
(deleting its accumulated KB content) and redo the entire onboarding wizard just to, say, switch
its cadence from weekly to daily. Two small additions instead, both reusing existing machinery —
no new infrastructure:

- **`/ask-admin set-cadence <name> daily|weekly`** — no wizard needed, it's a single field with
  a fixed set of values. The handler validates `<name>` exists in the registry and the value is
  `daily` or `weekly`, then calls `withRegistryRetry` to update just that entry's `cadence`,
  and replies ephemeral "`<name>` now refreshes `daily`." Takes effect on the next scheduled
  refresh run (`docs/design/04-scheduled-refresh.md`) — no immediate rebuild triggered.

- **`/ask-admin edit-repo <name>`** — reuses the exact same DM wizard mechanism as `add-repo`
  (state blob, steps, crafting call — see "Wizard state" and "Steps" above), pre-filled with
  the entry's current `audience`/`exampleQuestions`/`focusAreas`/`scopeNotes` so the admin only
  has to restate what's changing rather than re-answer everything from scratch. On confirm, it
  calls `withRegistryRetry` to replace just that entry's `promptSpec` — **it does not
  automatically re-trigger a full rebuild or re-write any existing KB pages.** The revised
  `promptSpec` simply becomes what the next incremental refresh (`docs/design/04-scheduled-refresh.md`)
  or self-heal gap-fill (`docs/design/03-qa-and-correction.md`) uses going forward. If an admin
  wants the effect immediately rather than waiting for the next scheduled/triggered run, they can
  separately `workflow_dispatch` `kb-refresh.yml` by hand (it already supports manual triggering)
  — no new command needed for that.

## Initial-build prompt (`src/kb/initialBuildPrompt.ts`)

Unlike the incremental refresh (Phase 4), there's no PR-diff history to lean on for a brand-new repo — the model has to explore the whole thing. To keep this bounded:

1. Seed the prompt with a **file-tree overview**: `git ls-files` inside the checked-out source, capped (e.g. first ~500 paths, noting truncation if more), grouped by top-level directory.
2. Include the repo's own README(s) verbatim (small, high-signal).
3. Inject the wizard's `PromptSpec` verbatim: audience, example questions, focus areas, scope notes — these become the model's north star for what to prioritize.
4. Constrain the output to the same fixed category-folder convention as the incremental prompt (`00-overview`, `01-...`, etc. — see `docs/design/04-scheduled-refresh.md` for the numbering convention), so page count stays bounded.
5. Explicitly instruct: "Use your Read/Grep/Glob tools to explore the source as needed, but do not attempt to read every file — use the file-tree overview and README to decide where to look first."
6. Output shape mirrors `KbPlan` (`summary` + `changes[]`), same as every other KB-writing prompt.

## `initialBuild.ts` entrypoint

```
1. Read repo_name, source_repo, prompt_spec_json, cadence, created_by from env (passed as workflow_dispatch inputs).
2. Build the initial-build prompt.
3. callClaude(prompt, auth, { cwd: <source checkout dir>, allowedTools: ["Read","Grep","Glob"] }).
4. parseKbResponse → KbPlan.
5. applyKbChanges(plan.changes, kbRoot, repo_name) — writes into repos/<repo_name>/knowledge-base/.
6. withRegistryRetry: add a new RegistryEntry { name: repo_name, sourceRepo, promptSpec, cadence,
   status: "active", createdBy: created_by, createdAt: now, lastRefreshedAt: now }.
7. commitAndPush the markdown files (single commit, e.g. "docs(kb): initial build for <repo_name>").
8. curl the deploy hook (see docs/design/06-deployment-showcase.md).
9. Post a DM/Slack notice to created_by: "Knowledge base for <repo_name> is ready — N pages created."
```

Support a `KB_DRY_RUN`-equivalent env flag that runs steps 1-5 and prints the would-be registry entry, skipping 6-9, so the prompt/output can be inspected via `git diff` before wiring the real dispatch end-to-end.

## Workflow: `.github/workflows/kb-initial-build.yml`

```yaml
on:
  workflow_dispatch:
    inputs:
      repo_name: {required: true}
      source_repo: {required: true}
      prompt_spec_json: {required: true}
      cadence: {required: true}
      created_by: {required: false, default: ""}

permissions:
  contents: write   # push to the KB repo

jobs:
  initial-build:
    runs-on: ubuntu-latest
    steps:
      - checkout ask-d2e (this repo, holds the code)
      - checkout ask-d2e-kb into ./kb (token: KB_REPO_TOKEN, push target)
      - checkout ${{ inputs.source_repo }} into ./src-checkout (token: SOURCE_REPOS_TOKEN)
      - setup-node, npm ci, npm i -g @anthropic-ai/claude-code
      - run npm run kb-initial-build
        env: CLAUDE_CODE_OAUTH_TOKEN, GITHUB inputs above, CLAUDE_TIMEOUT_MS: "900000" (15min — higher
             than the incremental refresh's 10min, since exploring a whole repo takes longer),
             VERCEL_DEPLOY_HOOK_URL, SLACK_BOT_TOKEN
```

Check during implementation whether the installed `claude` CLI exposes a turn/step cap flag; if so, wire it as an extra belt-and-suspenders bound alongside the timeout (see the open risk in `docs/PLAN.md`).

## Slack event/interaction wiring

- `api/slack-events.ts`: add a branch for `event.type === "message"` where `event.channel_type === "im"`, gated on `isAdmin(event.user)` — route into the wizard step-handler instead of (or before falling through to) the normal Q&A path.
- `api/slack-interactions.ts`: no new button action ids are strictly required if the wizard is driven entirely by plain-text replies ("yes"/"cancel"/restated answers) — simpler than adding Block Kit buttons for every step. If a Yes/No confirm button is preferred over parsing free text at the final step, add `wizard_confirm`/`wizard_cancel` action ids following the same pattern as the feedback buttons.
- `slack-app-manifest.yml`: add the `message.im` bot event and the `im:history` scope (alongside the existing `im:write`).

## Verification

- `KB_DRY_RUN`-equivalent local run of `initialBuild.ts` against a small test repo, inspect `git diff` in a scratch clone of the KB repo.
- Exercise the DM wizard against a single admin's own DM before enabling for the whole admin list — confirm the state-blob round-trip survives a few back-and-forth turns, including a mid-flow "cancel."
- `npm run typecheck`.
