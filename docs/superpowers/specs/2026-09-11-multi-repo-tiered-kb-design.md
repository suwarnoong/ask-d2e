# Multi-repo, tiered, release-aware knowledge base — design

> Status: approved design, not yet implemented.
> Supersedes the phase ordering in `docs/PLAN.md`; that document's phases 1–3 remain
> accurate as a description of what is already built.

## Context

`ask-d2e` today answers questions about one registered repo (`data2evidence` →
`OHDSI/Data2Evidence`) from a single code-derived knowledge base, merged wholesale into one
system prompt. Phases 1–3 of `docs/PLAN.md` are built and deployed at
`https://ask-d2e.vercel.app/`; phases 4 (scheduled refresh), 5 (remove-repo) and 6
(showcase page) are designed but not built.

This design expands that into a product serving two audiences:

- **Prospective partners** — evaluating Data2Evidence. Ask about setup, integration,
  compatibility, licensing, support model. Reached over the public web.
- **Installed partners** — already running Data2Evidence. Ask version-specific
  operational and troubleshooting questions. Reached over Slack.

Both are served by one answer engine over one knowledge base.

## Goals

1. Knowledge spans Data2Evidence and its dependencies — Atlas3, trex, and the
   OHDSI WebAPI 3.0 contract — deeply enough to answer questions whose answer
   crosses repo boundaries.
2. Answers are accurate for the D2E release a partner is actually running.
3. Commercial and support questions are answered from human-curated content, not
   inferred from source.
4. Troubleshooting is grounded in the official documentation's own
   symptom → cause → resolution material.
5. The system stays correct over time without manual re-authoring.

## Non-goals

- Per-repo version selection. There is exactly one user-facing version axis: the
  D2E release. Dependency versions are derived from it, never chosen independently.
- Supporting D2E releases older than v0.18.0-beta (see "Snapshot floor").
- Replacing the existing Slack wizard, feedback buttons, or self-heal correction
  loop. Those are retained and extended.
- Multi-org source repositories. The existing single-read-PAT assumption
  (`docs/PLAN.md` risk #6) is unchanged.

---

## Findings that constrain the design

These were verified against the actual repositories on 2026-09-11 and are the
factual basis for several decisions below. Re-verify before implementing if
significant time has passed.

### D2E pins its dependencies precisely

At any D2E release tag, the exact upstream commits are recoverable:

| Source | Location | Example (`develop`) |
|---|---|---|
| Atlas3 | `plugins/atlas/package.json` → `"@ohdsi/atlas3"` | `0.1.0-20260823112941-269a00a` → commit `269a00a` |
| trex | `services/trex/Dockerfile.v2` → `TREXSQL_REF` / `FROM` | `sha-5ce42757279f969bca123f0128a5c967ff2e3bd4` → commit `5ce4275` |

Verified across tags:

| D2E release | Atlas3 pin | trex pin | docs site |
|---|---|---|---|
| `develop` | `269a00a` | `5ce4275` | present (56 files) |
| `v0.18.1-beta` | `9baa99a` | `dec4a95` | present (53 files) |
| `v0.17.1-beta` | `3a0f3f3` | `754542f` | **absent** |
| `v0.16.0-beta` | **absent** | — | **absent** |

The trex pin changes shape across releases: an `ARG TREXSQL_REF=` on `develop`,
a hardcoded `FROM ghcr.io/ohdsi/trexsql:sha-…@sha256:…` at v0.17/v0.18. Both forms
must be handled.

### D2E does not ship OHDSI WebAPI

There is no `pom.xml` anywhere in the Data2Evidence tree.
`plugins/functions/d2e-webapi/` is a Deno/TypeScript reimplementation of the WebAPI
contract that talks to trex directly via `src/dao/trex.dao.ts`. The Java
`webapi-3.0` branch (`3.0.0-SNAPSHOT`, no release tags) is the upstream
*specification* D2E implements against, not a deployed component.

Consequence: blending upstream WebAPI knowledge into answers about a running D2E
install produces confident, wrong answers. WebAPI must be labelled as contract
reference throughout.

### The official documentation site lives in the D2E repo

`docs/website/` is a Docusaurus site: 56 markdown files under
`docs/website/docs/`, organised as `0-getting_started/`, `1-user_guide/` (9
sections), `2-admin_guide/` (including `5-setup/` and `6-knowledgebase/`).

Troubleshooting material is already structured:

```markdown
## Troubleshooting
### `illegal hardware instruction` when running `./d2e`
**Cause:** The binary downloaded does not match your system architecture.
**Resolution:** Check your architecture and re-download the correct binary.
```

Because it is version-controlled in the same repo, it snapshots per release for
free. Because it is human-authored, it should outrank code-derived inference.

### The curated FAQ is not derivable from source

The project manager's FAQ document (13 questions, real partner conversations)
covers legal/MOU requirements, licensing, release cadence, the support model
("no 24/7 SLA"), ETL support boundaries, and named research collaborations.
No amount of source analysis produces this content.

Two entries are unfinished and must be resolved before going live:

- **Q1** ends with an editorial note: *"Add details regarding technical
  requirements for D2E installation (docker, etc.)"* — fillable from the docs site.
- **Q10** trails off: *"But there may be another arrangement…"* — needs the PM.

Several FAQ claims are checkable against source and will drift: "50,000 user
accounts", "~6 week release cadence", "SSO via Microsoft Entra", "Bunny plugin for
federated cohort discovery", "Apache 2.0".

### The current context budget breaks at four repos

`api/_lib/answer.ts` renders the whole KB into the system prompt with a budget of
`max(600_000, 150_000 × repoCount)` characters, falling back to index-only when
exceeded. The single existing KB is already ~64k words (~420k characters). Four
repos across three snapshots would exceed the budget on essentially every query,
silently degrading every answer to index-only.

This is why retrieval must be redesigned before content expands.

---

## Architecture

### Three tiers of knowledge, with explicit authority

The knowledge base is not one kind of content with categories. It is three kinds
with different authority, different authors, and different refresh mechanics.

| Tier | Source | Authored by | Authority | Answers |
|---|---|---|---|---|
| 1 — Curated FAQ | PM's FAQ document | Humans, via PR | Highest; served near-verbatim | Legal, licensing, support model, commercial |
| 2 — Official docs | `docs/website/` in the D2E repo | D2E maintainers | High; human-authored, versioned | Setup, how-to, troubleshooting, known limitations |
| 3 — Generated KB | Code across D2E, Atlas3, trex, WebAPI | The bot | Depth and fallback | How it works internally, cross-repo integration |

Tier precedence is enforced as an explicit rule in the answer prompt, not left to
the model's judgement:

- Questions about a running install: tier 2 outranks tier 3.
- Legal, licensing, pricing, support-model questions: tier 1 only, never
  paraphrased into claims the PM did not write. If tier 1 does not cover it, the
  bot says so rather than inferring.
- Upstream WebAPI material: always labelled as contract specification, never
  presented as install behaviour.
- When tiers conflict: surface the conflict and cite both, rather than silently
  choosing.

### Snapshots

**A snapshot is one D2E release with its dependencies resolved to what that
release pinned.** One user-facing axis — "which D2E version are you on?" — but a
snapshot materialises as a coherent set: D2E at the tag, Atlas3 at its pinned
commit, trex at its pinned commit. This is what makes cross-repo questions
answerable for a specific install: the whole chain is read at mutually consistent
refs.

WebAPI sits outside the axis. It is built once from `webapi-3.0` and shared by all
snapshots.

**Supported set: `develop` plus the two most recent releases.** Today that is
`develop`, `v0.18.1-beta`, `v0.18.0-beta`. At the ~6-week cadence, each new release
adds one snapshot and retires the oldest, holding the set at three.

> `v0.18.0-beta` was not individually verified during design — only `develop`,
> `v0.18.1-beta`, `v0.17.1-beta` and `v0.16.0-beta` were. Phase D must verify that
> v0.18.0-beta carries both pins and the docs site before admitting it to the
> supported set; if it does not, the floor moves to v0.18.1-beta and the supported
> set is two until the next release.

**Snapshot floor: v0.18.0-beta.** Earlier releases have no docs site, so tier 2 —
the tier that carries troubleshooting — cannot be built for them. A partner on an
older release is told plainly that it is outside the supported range, and offered
the nearest supported answer with an explicit caveat. The bot does not guess.

**Release snapshots are immutable.** A released tag's code does not change, so a
release snapshot is built exactly once and never refreshed. Only the `develop`
snapshot runs the daily refresh cycle. This is what makes three snapshots
affordable: refresh cost stays roughly what it is today rather than tripling.

### Repository layout (`ask-d2e-kb`)

```
repos.json                              # unchanged: source repos, promptSpec, cadence
snapshots.json                          # NEW: the snapshot registry

curated/faq/*.md                        # tier 1, version-independent
repos/_shared/webapi-contract/**.md     # tier 3, version-independent

snapshots/<id>/manifest.json            # file index for retrieval
snapshots/<id>/docs/**.md               # tier 2, extracted from docs/website
snapshots/<id>/troubleshooting.json     # symptom-keyed index, derived from tier 2
snapshots/<id>/generated/<repo>/**.md   # tier 3, per-repo, code-derived
```

Tier 1 and the WebAPI contract live outside snapshots because legal, licensing and
contract-specification answers do not vary by D2E release.

`snapshots.json` entry shape:

```jsonc
{
  "id": "v0.18.1-beta",
  "d2eTag": "v0.18.1-beta",
  "pins": { "atlas3": "9baa99a", "trex": "dec4a95" },
  "status": "active",          // active | retired | building
  "builtAt": "2026-09-11T00:00:00.000Z",
  "isDevelop": false
}
```

### Retrieval: agentic file navigation

Chosen over embeddings (a new datastore to keep in sync per snapshot, with
chunk-level retrieval that fragments cross-repo chains) and over a fixed two-stage
prompt (cannot follow a trail that only becomes visible after the first read).

**Only the index is always in the prompt.** Each snapshot build emits
`manifest.json`: every KB file with path, title, and a one-line summary. Three
snapshots of manifest is a few thousand tokens, against the ~1.7MB of KB text that
would otherwise overflow.

**The system prompt carries:** the full tier-1 FAQ (~1,000 words — small enough to
ship whole, which is what makes it authoritative in practice), the manifest for the
selected snapshot, tier-precedence rules, and citation rules.

**Three tools**, scoped to the selected snapshot plus the shared tiers:

- `read_kb_file(path)` — full file contents
- `grep_kb(pattern, pathGlob?)` — regex search across the scoped set
- `list_kb_dir(path)` — directory listing

**Bounded** by a maximum turn count and a maximum total bytes read, so a
pathological question cannot run away. On hitting either bound, the bot answers
from what it has and says it was truncated.

**Citations stay path-exact**, now in the new shapes:
`snapshots/<id>/docs/...`, `snapshots/<id>/generated/<repo>/...`,
`curated/faq/<id>.md`, `repos/_shared/webapi-contract/...`.

The existing correction flow parses `repos/([^/]+)/` out of flagged answers to
decide which source repo to re-read. **That regex must be widened to the new path
shapes.** This is the one piece of existing behaviour this design breaks, and it
must be handled explicitly rather than discovered in production.

**Bundling is retained.** Three snapshots of markdown is roughly 5MB, comfortably
inside Vercel's limits. Bundling avoids GitHub rate limits and per-tool-call
latency. `scripts/build-kb-bundle.mjs` changes only in what it clones.

**Latency increases.** Multi-turn retrieval means seconds, not sub-second. Slack
already has the ack-then-`chat.update` pattern; web chat streams with visible
progress ("reading `docs/2-admin_guide/5-setup/0-system-setup/cli.md`"), which also
reads as more trustworthy to a prospect than an instantaneous answer.

### Surfaces

One `answerQuestion` core, two thin adapters.

**Slack** — internal staff and installed partners. Retains `/ask` and `@mention`,
feedback buttons, and the self-heal loop. Version resolution, in order: an inline
override (`/ask v0.17 why does X fail`), then a per-channel or per-user default set
by an admin, then `develop`.

**Web** — `ask-d2e.vercel.app`, prospective partners. The phase-6 showcase page
becomes a real chat UI. Unauthenticated. Version picker defaults to the **latest
release, not `develop`** — a prospect must never be shown unreleased behaviour.

A public endpoint needs controls the Slack path never did:

- IP-based rate limiting and a per-session question cap.
- Prompt-injection resistance on user input.
- Scope enforcement at the input, refusing off-topic questions rather than acting
  as a general-purpose LLM. This reuses the mechanism behind the existing
  `NO_KB_MATCH` sentinel, applied to the question rather than the answer.

Scope enforcement is a commercial requirement, not only a cost one: a
prospect-facing bot that answers anything is a liability; one that says "I can only
help with Data2Evidence" is a product.

### Build and refresh pipeline

Four workflows — two new, two adapted.

**`kb-snapshot-build.yml` (new).** Input: a D2E tag. Extracts pins, clones the
coherent set, runs tier-2 extraction and tier-3 generation, emits `manifest.json`
and `troubleshooting.json`, commits, registers the snapshot in `snapshots.json`.
Runs once per release.

**`kb-refresh.yml` (the unbuilt `docs/PLAN.md` phase 4).** Daily. Refreshes the
`develop` snapshot only. Also polls for a new D2E release tag and, on finding one,
dispatches `kb-snapshot-build.yml` and retires the oldest snapshot. Also runs FAQ
drift detection.

**`kb-initial-build.yml`, `kb-correct.yml` (existing).** Adapted to write into
snapshot paths and to resolve the widened citation shapes.

**The pin extractor is a real component**, with its own module and tests against
the actual tags listed in Findings. It handles two file formats and two trex pin
shapes, and it **fails loudly** rather than silently producing an incoherent
snapshot. A snapshot built from mismatched refs is worse than no snapshot, because
its answers look authoritative.

**Tier-2 extraction is deterministic, not generative.** Docusaurus markdown → KB
markdown is mechanical: strip frontmatter and MDX components, preserve heading
structure, rewrite relative links. `## Troubleshooting` sections are additionally
pulled into `troubleshooting.json`, keyed by symptom — partners arrive with an
error string, not a topic. An LLM writes only the one-line manifest summaries.
Docs content therefore reaches the answer **unaltered**, so a documented fix
cannot be paraphrased into a wrong one.

**Tier-1 ingestion.** The PDF becomes one markdown file per question under
`curated/faq/`, with frontmatter:

```yaml
---
id: faq-09
question: How does Data2Evidence manage multi-user access, permissions, and DataMarts?
tags: [access-control, rbac, sso, datamarts]
owner: project-manager
lastReviewed: 2026-09-11
verifiableClaims:
  - claim: SSO is supported via Microsoft Entra
  - claim: Role-Based Access Control is fine-grained
  - claim: DataMarts can restrict exposure to specified tables, columns, or cohorts
---
```

Authored and reviewed by humans via PR. **The bot never writes to `curated/`.**

**FAQ drift detection** runs inside the daily job. For each `verifiableClaims`
entry, check it against the current `develop` snapshot's tiers 2 and 3, and DM
admins on mismatch — for example: *"FAQ Q9 claims Microsoft Entra SSO; no Entra
integration found in develop as of 2026-09-11."* It **never edits and never opens
PRs**; it tells a human. This is the mechanism that stops the prospect-facing tier
from quietly rotting, without ceding editorial control over commercially sensitive
copy.

---

## Error handling

- **Pin extraction failure** — abort the snapshot build, leave `snapshots.json`
  untouched, alert admins. Never register a partially-built or incoherent snapshot.
- **Unsupported version requested** — state plainly that the release is outside the
  supported range, name the supported set, and offer the nearest supported answer
  with an explicit caveat. Never silently answer from a different version.
- **Retrieval bound exhausted** — answer from what was read, and say explicitly
  that the search was truncated.
- **No tier covers the question** — the existing `NO_KB_MATCH` path, extended: for
  tier-1 territory (legal, licensing, support) the bot must decline rather than
  fall back to tiers 2 or 3.
- **Tier conflict** — surface it and cite both sources.
- **Public endpoint abuse** — rate-limit, cap per session, refuse off-topic.

## Testing

- **Pin extractor**: unit tests against the real tags in Findings, including
  `v0.16.0-beta` where the Atlas3 pin is absent and extraction must fail cleanly.
- **Tier-2 extraction**: golden-file tests over real `docs/website/` fixtures,
  including troubleshooting-section parsing.
- **Tier precedence**: cases where tiers disagree, asserting the right tier wins
  and conflicts surface.
- **Retrieval loop**: bounded-turn and bounded-bytes enforcement; a question whose
  answer requires following a chain across two repos.
- **Citation round-trip**: every citation shape the answer engine can emit must be
  resolvable by the correction flow's parser. This guards the one known break.
- **Version routing**: inline override beats channel default beats `develop`; web
  defaults to latest release, never `develop`.
- **Drift detection**: a known-stale claim is detected; a known-current claim
  produces no alert.

Existing conventions hold: Node's built-in `node:test` via `tsx --test`, no new
test-framework dependency.

## Sequencing

Reorders `docs/PLAN.md`'s phases, on the principle that cheap correctness wins land
before expensive content expansion.

| # | Phase | Rationale | Depends on |
|---|---|---|---|
| A | Retrieval redesign — manifest + agentic tools, against today's single KB | Unblocks everything; provable with zero new content | — |
| B | Tier-1 FAQ ingestion and authority rules | Cheapest real value; the prospect use case works after this | A |
| C | Tier-2 docs extraction for `develop` | Largest correctness gain per unit of work | A |
| D | Snapshot machinery — pin extractor, `snapshots.json`, version selector | Makes the version axis real | C |
| E | Onboard Atlas3, trex, WebAPI-as-contract | The multi-repo depth | D |
| F | Scheduled refresh, new-release detection, FAQ drift | Makes it maintained rather than a point-in-time snapshot | D, B |
| G | Web surface, rate limiting, scope guards | Opens it to prospects once answers are trustworthy | B, C |

**A → B → C is the critical path to something genuinely useful.** After C, the bot
answers setup, troubleshooting and commercial questions correctly from
human-authored sources — most of both use cases. D–G add version accuracy,
cross-repo depth, maintenance, and public access.

## Risks

1. **Phase E is the most expensive and least certain.** Generating good
   code-derived KBs for trex (a large Rust/Deno hybrid) and Atlas3 (a large Vue
   monorepo) is where `docs/PLAN.md` risk #4 — initial-build scope bounding —
   actually bites. C and D should be proven before committing to E.
2. **Citation-shape change breaks the existing correction parser.** Known, and
   covered by a round-trip test, but it is a real break in deployed behaviour.
3. **Agentic retrieval latency** is unproven against real questions. If multi-turn
   navigation proves too slow for Slack even with `chat.update`, the fallback is
   the two-stage approach, at the cost of cross-repo chain-following.
4. **The public web endpoint is a new abuse surface.** Rate limiting and scope
   guards are necessary but not sufficient; expect to iterate after real traffic.
5. **Two FAQ entries are unfinished** (Q1, Q10) and block tier 1 going live.
   Resolving them depends on the PM, not on engineering.
6. **The snapshot floor is v0.18.** Partners on older releases get no
   version-accurate answer. If a significant number run older releases, the floor
   needs revisiting — and tier 2 cannot be built for them at all.
7. **Pin formats may change again.** They already changed shape between v0.17 and
   `develop`. The extractor must fail loudly on an unrecognised format, and will
   need maintenance as D2E evolves.
