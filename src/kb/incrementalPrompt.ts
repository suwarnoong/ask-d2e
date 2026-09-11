import type { DigestData } from "../shared/githubDiff.js";
import type { PromptSpec } from "./registry.js";

export function renderPrData(data: DigestData): string {
  const lines: string[] = [
    `Repo: ${data.repo}`,
    `Window start: ${data.since}`,
    `Totals: ${data.totals.prCount} merged PR(s) from ${data.totals.authorCount} author(s), ` +
      `+${data.totals.additions}/-${data.totals.deletions}`,
    "",
  ];
  for (const pr of data.prs) {
    lines.push(
      `===== PR #${pr.number}: ${pr.title} =====`,
      `Author: ${pr.author} | ${pr.html_url}`,
      `Churn: +${pr.additions}/-${pr.deletions} across ${pr.changed_files} file(s)` +
        (pr.labels.length ? ` | Labels: ${pr.labels.join(", ")}` : ""),
      `Description: ${pr.body_excerpt || "(none)"}`,
      pr.diff_truncated
        ? "NOTE: this diff was TRUNCATED at the size cap — read the real files before judging it."
        : "",
      "",
      pr.diff,
      "",
    );
  }
  return lines.filter((l) => l !== undefined).join("\n");
}

export function buildIncrementalPrompt(
  sourceRepo: string,
  repoName: string,
  promptSpec: PromptSpec,
  data: DigestData,
  renderedKb: string,
): string {
  const pathPrefix = `repos/${repoName}/knowledge-base/`;
  return `
You maintain a Markdown knowledge base documenting ${sourceRepo} for ${promptSpec.audience}.
Below are (1) the current KB files for this repo and (2) merged PRs since ${data.since}, with
actual code diffs. Compare the diffs against the current docs; propose edits where merged code
makes a documented behavior/name/number/flow/feature out of date, AND draft NEW pages for
substantial features with no coverage yet.

Focus areas to prioritize:
${promptSpec.focusAreas.map((f) => `- ${f}`).join("\n")}
${promptSpec.scopeNotes ? `Scope notes (explicitly out of scope): ${promptSpec.scopeNotes}` : ""}

Rules:
- Base every change on the ACTUAL DIFF, not just PR titles/bodies. Never invent details.
- The diff tells you what changed and where; it is a POINTER, not the only source of truth — the
  full checked-out source is available in your working directory via Read/Grep/Glob. If a diff is
  truncated, ambiguous, or you need to see a full file or its callers to judge the change's real
  effect, read the actual current file instead of guessing from the diff alone.
- Be conservative: an EMPTY changes array is correct and expected on most runs.
- "update" replaces a file in FULL (not a patch); preserve existing structure/tone, change only
  what the diff requires. "create" adds a new file following the existing category-folder
  convention (00-overview/, 01-..., 02-..., etc.).
- GitHub-Flavored Markdown matching the existing files (# headings, -/1. bullets, fenced code) —
  this is NOT Slack, no single-asterisk-only bold, no Slack link syntax.
- Cite the PR number(s) that justify each change in "source_prs".

===== CURRENT KNOWLEDGE BASE =====
${renderedKb}

===== MERGED PRS =====
${renderPrData(data)}

CRITICAL: every "path" in your response MUST start with the exact prefix "${pathPrefix}" —
for example "${pathPrefix}00-overview/intro.md". Do NOT write bare paths — they will be rejected.

Respond with a single JSON object shaped as:
{ "summary": string, "changes": [ { "path": string, "action": "update"|"create", "rationale": string, "source_prs": number[], "content": string } ] }
`.trim();
}
