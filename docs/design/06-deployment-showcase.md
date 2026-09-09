# Phase 6: Deployment bundling/deploy-hook + showcase page + branding

## Build-time KB clone (`scripts/build-kb-bundle.mjs`)

Since the KB now lives in a separate repo, the build step must materialize it locally before functions are bundled, preserving the "whole KB cached in one system prompt, no vector DB" design:

```js
// env: KB_REPO ("suwarnoong/ask-d2e-kb"), KB_REPO_TOKEN, KB_BRANCH (default "main")
// shallow-clone https://x-access-token:${KB_REPO_TOKEN}@github.com/${KB_REPO}.git
//   --branch ${KB_BRANCH} --depth 1 into ./knowledge-base
// fail the build loudly if the clone fails — an unreachable KB repo should not silently
// ship a stale or empty bundle.
```

## `vercel.json`

```json
{
  "buildCommand": "node scripts/build-kb-bundle.mjs",
  "outputDirectory": "public",
  "functions": {
    "api/ask.ts": { "maxDuration": 60, "includeFiles": "knowledge-base/**" },
    "api/slack-events.ts": { "maxDuration": 60, "includeFiles": "knowledge-base/**" }
  }
}
```

`includeFiles` stays the same glob as a single-repo setup would use — the clone target keeps the folder name `knowledge-base/`, it just now contains `repos.json` + nested `repos/<name>/knowledge-base/**` instead of a flat tree. `api/slack-interactions.ts` and `api/ask-admin.ts` need no `includeFiles` entry — neither reads the merged KB (the wizard crafts its `promptSpec` from the conversation itself, not from existing KB content).

## The domain is already live — this is a cutover, not a fresh launch

`https://ask-d2e.vercel.app/` is already deployed and serving traffic today: it currently shows the existing single-repo showcase page and copy ("Answers from the D2E knowledge base, right in Slack"), and its Slack app's Request URLs presumably already point at this domain for a real, in-use workspace. This changes Phase 6 (and really the whole rollout) from "stand up a new site" to "safely replace a live production deployment without breaking the bot mid-migration."

Before touching this domain:
1. **Confirm which hosting project currently owns it** and what it's connected to (which GitHub repo/branch triggers its deploys) — unknown as of this plan and needs checking before any cutover step, since repointing the wrong thing could take down a working bot.
2. **Build and verify the new multi-repo app against a separate preview deployment first** (a preview deployment from a branch/PR, or a throwaway second hosting project) — exercise Phases 1-4 end-to-end there, not against the live domain.
3. **Only cut over once verified**: either repoint the existing hosting project's connected repo/branch to `ask-d2e`, or update its production domain assignment to a new project built from `ask-d2e` — the choice depends on what's found in step 1, and should be a deliberate, confirmed step (not a side effect of an early-phase push), since it will change what real users' `/ask` and `@ask-d2e` currently do.
4. **Keep the single-repo behavior working until the multi-repo replacement is confirmed equivalent-or-better** — e.g. don't cut over until at least one repo is fully onboarded (Phase 2) and answering correctly (Phase 3) through the new system, so there's no window where the live bot regresses to "no repos configured, no answers."

## Deployment domain and Slack app manifest

The app deploys to **`https://ask-d2e.vercel.app/`**. `slack-app-manifest.yml`'s Request URLs are fixed values pointing at that domain — no placeholder substitution needed at setup time:

```yaml
features:
  slash_commands:
    - command: /ask
      url: https://ask-d2e.vercel.app/api/ask
      description: Ask the knowledge base
      usage_hint: how does the query engine work?
    - command: /ask-admin
      url: https://ask-d2e.vercel.app/api/ask-admin
      description: Admin actions (add/remove a repo)
      usage_hint: add-repo owner/name
settings:
  event_subscriptions:
    request_url: https://ask-d2e.vercel.app/api/slack-events
    bot_events: [app_mention, message.im]
  interactivity:
    is_enabled: true
    request_url: https://ask-d2e.vercel.app/api/slack-interactions
```

**Decided**: `/ask-admin` is its own dedicated slash command (`api/ask-admin.ts`), not folded into `/api/ask`. `/ask-admin add-repo owner/name` starts the wizard (see `docs/design/02-admin-wizard.md`); `/ask-admin remove-repo <name>` starts the one-shot confirm (see `docs/design/05-remove-repo.md`). Both check `isAdmin(user_id)` before doing anything — a non-admin gets a plain "admins only" ephemeral reply.

## Deploy hook — closing the loop automatically

Every KB-mutating workflow (`kb-refresh.yml`, `kb-initial-build.yml`, `kb-correct.yml`, `kb-remove-repo.yml`) ends with:

```yaml
- name: Trigger redeploy
  if: steps.commit.outputs.pushed == 'true'
  run: curl -fsS -X POST "${{ secrets.DEPLOY_HOOK_URL }}"
```

Create the hook once in the hosting project's settings (Git → Deploy Hooks), store the URL as `DEPLOY_HOOK_URL`. This makes "the bot's answers reflect the latest KB" fully automatic — no one has to remember to manually redeploy after a correction lands.

## Showcase page (`public/index.html`) — built

A single static page (no framework, no build step yet — this was built standalone, ahead of Phases 1-5, since it has no dependency on the backend), user-facing only (no admin wizard/onboarding UI or copy — Phase 2's admin capability is deliberately not represented here). Sections, in order, as actually implemented:

1. **Header** — logo mark + wordmark, nav links (How it works / Features / Limitations), an "Open in Slack" link.
2. **Hero** — kicker badge, headline generalized to "your team's repos" (not a single named platform), one-line description, two CTAs (primary "Open in Slack", ghost "See how it works"), a row of 3 truthful stat callouts ("3 ways to ask", "100% answers cited", "Any repo you configure" — deliberately qualitative rather than a fabricated repo count or a single fixed refresh cadence, since cadence is per-repo and there's no live count to report from a static page), and an **animated Slack conversation demo**: a fake chat window that types out a question, shows a "thinking" ellipsis, streams in an answer, then reveals a source citation + 👍/👎 buttons.
   - **Demo scenes, as built**: both current scenes cite `repos/d2e-platform/...` paths (real, accurate D2E platform facts) rather than inventing a second unconfigured repo's content — honest over illustrative. Once a second repo is actually onboarded (Phase 2), add a scene citing its real `repos/<name>/...` path here instead of fabricating one now.
3. **How it works** — 3 numbered steps: ask in Slack → it searches the base → cited answer back. The 👎-fixes-it detail is stated as a bot capability, not framed as an admin workflow.
4. **Features grid** — 6 cards as built: grounded & cited, two ways to ask, follow-up aware, **"One bot, every repo"** (new — phrased as an end-user benefit: the bot knows more, not as "admins can onboard repos"), powered by AI, self-improving base (merges the 👎-correction, per-repo scheduled refresh, and unanswered-question-flagging facts into one card rather than a separate "gap alerts for admins" card, to avoid dedicating a whole card to an admin-facing mechanic).
5. **How to use** — two example commands (`/ask ...`, `@mention ...`), unchanged.
6. **Limitations** — the original list plus one new bullet: **"Only covers configured repos"** — states the scope constraint honestly (an end-user-relevant fact: some codebases may not be covered) without describing how admins configure it. The former "Feedback is admin-only" bullet was rewritten to **"Anyone can flag an answer, admins approve the fix"**, reflecting the visibility/trigger split in `docs/design/03-qa-and-correction.md` ("Who can vote, who can trigger a fix") — feedback buttons now show for every asker, only the automatic fix stays admin-gated. The "Knowledge-base only" bullet now also mentions self-heal (checks the real source before giving up on an uncovered question). The "Self-improving base" feature card was updated to mention self-heal as well as 👎-triggered fixes and scheduled refresh — see `docs/design/03-qa-and-correction.md`, "Self-heal on uncovered answers."
7. **Closing CTA band** — repeat the primary "Open in Slack" CTA.
8. **Footer** — brand line generalized to "the knowledge bases your team configures" + repeated nav links.

Behavior (unchanged from the reference implementation): scroll-reveal via `IntersectionObserver` (`.reveal` → `.reveal.in` on 15% visibility), full `prefers-reduced-motion` support (skip all animation, show the static first demo scene immediately), and a typewriter-style effect for the chat demo (character-by-character with slight jitter, then a pause before cycling to the next scene).

**Status**: implemented at `public/index.html` (plus `public/logo.svg` and `public/favicon.ico`, reused as-is — same brand mark, no redesign needed). Not yet wired to a build step or backend — it's a standalone static page today; the KB-clone build step, `vercel.json`, and deploy hook (above) get added once Phase 1+ exists for it to depend on. Branding has been verified against the live site (below) — open risk #7 is closed.

## Branding — verified against the live data2evidence.org

Checked via a live browser session (computed styles, not guessed from static HTML):

```css
--bg: #ffffff;
--tint: #f2f0f1;
--tint-2: #faf8f8;
--text: #1c1b29;
--muted: #595757;
--accent: #000080;       /* navy — data2evidence.org's --ifm-color-primary, exact match */
--accent-dark: #3333cc;  /* data2evidence.org's --ifm-color-primary-light, exact match */
--wash: #e5e6f2;
--border: #dedcda;
```

**Findings:**
- **Primary color**: `rgb(0, 0, 128)` (`#000080`) — exactly what this page already used. No change needed there.
- **Accent/hover color**: their `--ifm-color-primary-light` is `#3333cc`, close to but not identical to the `#333399` this page started with — updated to the exact value.
- **Buttons**: white text on navy, fully pill-shaped (`border-radius: 30px` at their size), bold weight — matches this page's existing `.btn-primary` treatment (999px radius reads as a full pill at this page's button size).
- **Background**: plain white — matches.
- **Typography**: their body/nav font is `GT-America, Helvetica, Arial, sans-serif`; their *one* large hero wordmark ("Data2Evidence" itself) uses a separate serif display font (`MetaSerifPro, Georgia, serif`), but their own section headings (e.g. "Transforming health research") are **also** GT-America sans, not serif — the serif treatment is a one-off logotype flourish on their brand name, not a general heading style. Both GT-America and MetaSerifPro are commercial/licensed typefaces (Grilli Type and LucasFonts respectively); this page has no license for either. Rather than trying to find an open lookalike, this page now uses the exact **fallback stack** their own site would show to a visitor without those fonts installed — `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif` — for everything, and dropped the previously-loaded IBM Plex Sans Variable CDN font entirely (one fewer external request, and a more honest match than an unrelated open-source font).

## Verification

- `node scripts/build-kb-bundle.mjs` against the real (or a disposable fixture) `ask-d2e-kb` repo; confirm `./knowledge-base/repos.json` and nested `repos/<name>/knowledge-base/**` land correctly and the build fails loudly on a bad token/unreachable repo.
- A local dev server smoke test of `/api/ask` against the freshly-cloned fixture KB.
- Visual review of the page at a few breakpoints (the layout collapses to single-column under ~860px); confirm `prefers-reduced-motion` is respected.
