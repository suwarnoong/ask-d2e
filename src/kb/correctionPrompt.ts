const OUTPUT_SHAPE_INSTRUCTION = `
Respond with a single JSON object shaped as:
{ "summary": string, "changes": [ { "path": string, "action": "update"|"create", "rationale": string, "source_prs": [], "content": string } ] }
`.trim();

function buildFixPrompt(sourceRepo: string, question: string, answer: string): string {
  return `
You maintain a Markdown knowledge base documenting ${sourceRepo}. A user asked ask-d2e a
question; the bot answered FROM THE KB; the user marked the answer WRONG or incomplete.

Question: ${question}
Bot's answer (flagged wrong): ${answer}

Find out what's actually true by reading the real source (checked out in your working directory)
using Read/Grep/Glob, then fix the KB page(s) whose content produced the bad answer. Ground the
correction in the code, NOT the existing KB wording (which is what misled the answer). Preserve
each file's structure/tone; only correct what the code contradicts. If, after checking, the
original answer was actually correct, return an empty changes array explaining why in the summary
— do not invent edits.

${OUTPUT_SHAPE_INSTRUCTION}
`.trim();
}

function buildGapFillPrompt(sourceRepo: string, question: string, fileTreeOverview: string, readmes: string): string {
  return `
You maintain a Markdown knowledge base documenting ${sourceRepo}. A user asked ask-d2e a question
the current KB doesn't cover.

Question: ${question}

File tree overview:
${fileTreeOverview}

README(s):
${readmes}

Using the file-tree overview and README(s) above as a starting map, explore the real source
(checked out in your working directory) with Read/Grep/Glob to find out if this is something the
KB should document. If you find a real, substantial answer, create or update the appropriate
page(s) under the existing category convention. If the question turns out to be out of scope for
this repo, or you can't find enough to write a grounded page, return an empty changes array
explaining why — do not invent a page just to have something to show.

${OUTPUT_SHAPE_INSTRUCTION}
`.trim();
}

export function buildCorrectionPrompt(
  mode: "fix" | "gap-fill",
  sourceRepo: string,
  question: string,
  answer: string,
  fileTreeOverview?: string,
  readmes?: string,
): string {
  if (mode === "fix") return buildFixPrompt(sourceRepo, question, answer);
  return buildGapFillPrompt(sourceRepo, question, fileTreeOverview ?? "", readmes ?? "");
}
