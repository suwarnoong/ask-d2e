import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "./gitOps.js";
import type { PromptSpec } from "./registry.js";

export interface PromptTarget {
  /** Repo-relative prefix every "path" in the response must start with. */
  pathPrefix: string;
  /** Extra instruction for material that is not install behaviour (the WebAPI contract). */
  contractNote?: string;
}

export function listSourceFiles(sourceDir: string, cap = 500): string[] {
  const all = git(sourceDir, ["ls-files"]).split("\n").filter(Boolean);
  return all.slice(0, cap);
}

export function readReadmes(sourceDir: string): string {
  const candidates = readdirSync(sourceDir).filter((f) => /^readme(\.md)?$/i.test(f));
  return candidates
    .map((f) => `--- ${f} ---\n${readFileSync(join(sourceDir, f), "utf8")}`)
    .join("\n\n");
}

export function buildFileTreeOverview(fileList: string[], cap = 500, totalFileCount = fileList.length): string {
  const grouped = new Map<string, string[]>();
  for (const path of fileList) {
    const top = path.includes("/") ? path.split("/")[0] + "/" : "(root)";
    if (!grouped.has(top)) grouped.set(top, []);
    grouped.get(top)!.push(path);
  }
  const lines: string[] = [];
  for (const [top, paths] of grouped) {
    lines.push(top);
    for (const p of paths) lines.push(`  ${p}`);
  }
  if (totalFileCount > cap) {
    lines.push("", `... truncated: showing the first ${cap} of ${totalFileCount} files.`);
  }
  return lines.join("\n");
}

export function buildInitialBuildPrompt(
  sourceRepo: string,
  repoName: string,
  promptSpec: PromptSpec,
  fileList: string[],
  readmes: string,
  totalFileCount: number,
  target: PromptTarget = { pathPrefix: `repos/${repoName}/knowledge-base/` },
): string {
  const overview = buildFileTreeOverview(fileList, fileList.length, totalFileCount);
  const pathPrefix = target.pathPrefix;
  const contractNote = target.contractNote ? `${target.contractNote}\n\n` : "";
  return `
You maintain a Markdown knowledge base documenting ${sourceRepo}. Build the initial knowledge base
from scratch by exploring the real source, checked out in your working directory.

${contractNote}Audience: ${promptSpec.audience}
Example questions it should be able to answer:
${promptSpec.exampleQuestions.map((q) => `- ${q}`).join("\n")}
Focus areas to prioritize:
${promptSpec.focusAreas.map((f) => `- ${f}`).join("\n")}
Scope notes (explicitly out of scope): ${promptSpec.scopeNotes}

File tree overview:
${overview}

README(s):
${readmes}

Use your Read/Grep/Glob tools to explore the source as needed, but do not attempt to read every
file — use the file-tree overview and README to decide where to look first.

Write pages under a fixed category-folder convention: 00-overview/, then numbered category folders
(01-..., 02-..., etc.) grouping related topics. Keep page count bounded — do not create a separate
page per file.

CRITICAL: every "path" in your response MUST start with the exact prefix "${pathPrefix}" —
for example "${pathPrefix}00-overview/intro.md" or "${pathPrefix}03-cloud-functions/query-service.md".
Do NOT write bare paths like "00-overview/intro.md" — they will be rejected.

Respond with a single JSON object shaped as:
{ "summary": string, "changes": [ { "path": string, "action": "create", "rationale": string, "source_prs": [], "content": string } ] }
`.trim();
}
