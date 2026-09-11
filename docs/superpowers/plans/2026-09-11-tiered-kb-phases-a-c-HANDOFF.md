# Handoff prompt — ask-d2e tiered KB, phases A–C

> Paste the block below as the opening message to the implementing agent.
> It assumes the working directory layout described in "Environment".

---

You are implementing a written, approved plan. Do not redesign it.

## Your task

Implement **phases A–C** of the ask-d2e tiered knowledge base, exactly as specified in:

- **Plan (what to build, task by task):** `docs/superpowers/plans/2026-09-11-tiered-kb-phases-a-c.md`
- **Spec (why it is built this way):** `docs/superpowers/specs/2026-09-11-multi-repo-tiered-kb-design.md`

Read the spec first, then the plan, in full, before writing any code. The plan has 14 tasks, each with exact file paths, complete test code, complete implementation code, and an `Interfaces` block naming the signatures neighbouring tasks depend on. Follow it task by task, in order.

**Required sub-skill:** use `superpowers:subagent-driven-development` (preferred — a fresh subagent per task with review between) or `superpowers:executing-plans`. Also use `superpowers:test-driven-development` within each task and `superpowers:verification-before-completion` before claiming anything passes.

## Environment

```
/Users/khairulsyazwan/Documents/suwarno-hackathon/
├── ask-d2e/                    ← the code repo; work here
├── ask-d2e-kb/                 ← the CONTENT repo; tasks 10 and 14 commit here
├── upstream/
│   ├── Data2Evidence/          ← source for task 12–14 smoke tests (docs/website/docs)
│   ├── Atlas3/  WebAPI/  trex/ ← reference only; not touched in phases A–C
└── 2609_FAQ list_Data4Life.pdf ← source content for task 10
```

Both `ask-d2e` and `ask-d2e-kb` are real git repos with remotes. `upstream/*` are shallow read-only clones — never commit or push there.

Start from branch `design/tiered-multi-repo-kb` in `ask-d2e` (it holds the spec and plan). Create a working branch off it. Never commit directly to `main`/`master` in either repo, and do not push or open a PR unless asked.

End every commit message with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

## Non-negotiable constraints

These come from the plan's Global Constraints and the repo's existing conventions. Violating them means redoing work.

- **No new dependencies**, runtime or dev. Frontmatter is parsed by a purpose-written restricted parser (task 8), not a YAML library. Tests use Node's built-in `node:test` / `node:assert/strict` via `tsx --test`.
- **ESM with the `.js`-suffix-on-`.ts`-source import convention** — `import { required } from "./config.js"` from a sibling `.ts` file. Getting this wrong fails at runtime, not at typecheck.
- **Tier 2 content is never rewritten by a model.** Docs extraction is deterministic string transformation. If you find yourself reaching for an LLM call in task 12 or 13, you have misread the plan.
- **The bot never writes to `curated/`.** Tier 1 is human-authored.
- **Citations are path-exact.** Task 7 widens the parser; every citation shape the answer engine can emit must round-trip through `resolveRepoFromCitation`, and `curated/…` must resolve to `null` — that is a safety property, not an oversight.
- Files stay under 800 lines, functions under 50. No mutation of inputs.

## Verification

Per task, the commands are in the task's own steps. Before declaring any phase complete:

```bash
cd /Users/khairulsyazwan/Documents/suwarno-hackathon/ask-d2e
npm run typecheck && npm run typecheck:api && npm test
```

Phase C additionally requires the end-to-end proof in task 14 step 6: build the real docs tier from `../upstream/Data2Evidence/docs/website/docs`, then confirm `grep_kb` finds a real troubleshooting symptom inside `snapshots/develop/`. Do not claim phase C is done without running that and showing its output.

The plan's "Done criteria" section is the final checklist. Work through it literally.

## Traps found during design

1. **Task 6 deletes existing tests.** `renderKbForPrompt` is removed, so the tests asserting its budget/index-only behaviour go with it. That is intended — do not preserve them. Keep the `readAllRepoKbs` tests.
2. **`defaultBudget()` is a function, not a const**, specifically so tests can set `RETRIEVAL_MAX_TURNS` after import. Do not "simplify" it to a module-level constant.
3. **`CITATION_RE` carries the `g` flag**, so `RegExp.test` is stateful. `hasKbCitation` resets `lastIndex` before testing. Removing that reset produces intermittent false negatives that pass in tests and fail in production.
4. **`AnthropicLikeClient` is widened, never narrowed** (task 3). If an existing test stub stops satisfying the type, fix the stub.
5. **Task 10 is content work in the other repo**, copied verbatim from the PM's PDF. Do not improve, condense or rephrase the answers — this is commercially reviewed copy. `faq-01` and `faq-10` are unfinished in the source and must ship with `status: draft`; drop their trailing editorial fragments from the body.
6. `pdftotext` is already installed (via poppler). Regenerate the FAQ source with `pdftotext -layout "2609_FAQ list_Data4Life.pdf" /tmp/faq.txt`.
7. **Smoke tests in tasks 12–14 read the real D2E docs tree.** If a doc shows leftover JSX or an unrecognised troubleshooting label, add a regression test for that exact shape *first*, then extend the parser. Do not widen a regex blind.

## Out of scope

Phases D–G of the spec — snapshot machinery and the pin extractor, onboarding Atlas3/trex/WebAPI, scheduled refresh and drift detection, and the public web surface. Each gets its own plan later. Two seams are deliberately left stubbed and must stay stubbed:

- `answerQuestion`'s `snapshotId` parameter is honoured but nothing offers a version picker; everything gets `develop`.
- `verifiableClaims` are parsed and validated but nothing consumes them.

Do not build ahead into these.

## When to stop and ask

Stop and raise it rather than improvising if:

- A task's code as written does not typecheck or its test does not fail for the stated reason — that means the plan has a bug worth fixing in the plan, not silently working around.
- The real D2E docs tree has changed shape enough that task 12–14 smoke tests do not produce roughly 56 docs and a non-zero troubleshooting count.
- Any task would require adding a dependency, or writing to `curated/`.

Otherwise, work through the plan and report per task: what you built, the verification command you ran, and its actual output.
