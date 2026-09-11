import type { ExtractedDoc } from "./docsExtract.js";

export interface TroubleshootingEntry {
  symptom: string;
  cause: string;
  resolution: string;
  /** Path of the doc this came from, used as the citation. */
  sourcePath: string;
}

const SECTION_RE = /^##\s+troubleshooting\s*$/im;
const NEXT_H2_RE = /^##\s+/m;
const SYMPTOM_SPLIT_RE = /^###\s+/m;

function labelled(block: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[A-Z]|$)`, "i");
    const match = block.match(re);
    if (match) return match[1].trim().replace(/\s*\n\s*/g, " ");
  }
  return "";
}

/**
 * Flattens a label-less entry body. The real docs contain sections that state
 * the symptom's handling as plain bullet prose with no labelled fields at all.
 */
function flattenProse(block: string): string {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTroubleshooting(doc: ExtractedDoc): TroubleshootingEntry[] {
  const start = doc.content.search(SECTION_RE);
  if (start === -1) return [];

  const afterHeading = doc.content.slice(start).replace(SECTION_RE, "");
  const nextH2 = afterHeading.search(NEXT_H2_RE);
  const section = nextH2 === -1 ? afterHeading : afterHeading.slice(0, nextH2);

  return section
    .split(SYMPTOM_SPLIT_RE)
    .slice(1)
    .map((block) => {
      const newline = block.indexOf("\n");
      const symptom = (newline === -1 ? block : block.slice(0, newline)).trim();
      const body = newline === -1 ? "" : block.slice(newline + 1);
      const cause = labelled(body, ["Cause"]);
      const resolution = labelled(body, ["Resolution", "Fix", "Workaround"]);
      return {
        symptom,
        cause,
        // An entry that states only a cause keeps an empty resolution, per plan;
        // an entry with no recognised label at all falls back to its prose.
        resolution: resolution || (cause ? "" : flattenProse(body)),
        sourcePath: doc.outPath,
      };
    })
    .filter((entry) => entry.symptom !== "");
}

export function buildTroubleshootingIndex(docs: ExtractedDoc[]): TroubleshootingEntry[] {
  return docs
    .flatMap(extractTroubleshooting)
    .sort((a, b) => (a.symptom < b.symptom ? -1 : a.symptom > b.symptom ? 1 : 0));
}

export function renderTroubleshootingIndex(entries: TroubleshootingEntry[]): string {
  if (entries.length === 0) {
    return "TROUBLESHOOTING INDEX: no troubleshooting entries were found in the documentation.";
  }
  const lines = [
    `TROUBLESHOOTING INDEX — ${entries.length} known symptoms from the official documentation.`,
    "Match the user's error text against a symptom, then read the source file for full context.",
    "",
  ];
  for (const e of entries) {
    lines.push(`### ${e.symptom}`);
    if (e.cause) lines.push(`Cause: ${e.cause}`);
    if (e.resolution) lines.push(`Resolution: ${e.resolution}`);
    lines.push(`Source: ${e.sourcePath}`, "");
  }
  return lines.join("\n").trim();
}
