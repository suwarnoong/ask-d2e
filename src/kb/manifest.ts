import type { KbFile } from "./kbFiles.js";

export interface ManifestEntry {
  path: string;
  title: string;
  summary: string;
}

export interface KbManifest {
  snapshotId: string;
  generatedAt: string;
  entries: ManifestEntry[];
}

const HEADING_RE = /^#{1,6}\s+(.+)$/m;

/** First markdown heading in the document, or a stable placeholder. */
export function extractTitle(content: string): string {
  const match = content.match(HEADING_RE);
  if (!match) return "(untitled)";
  const heading = match[1].replace(/\s*#+\s*$/, "").trim();
  return heading === "" ? "(untitled)" : heading;
}

export function buildManifest(
  snapshotId: string,
  files: KbFile[],
  summarize: (file: KbFile) => string,
): KbManifest {
  const entries = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      path: file.path,
      title: extractTitle(file.content),
      summary: summarize(file),
    }));
  return { snapshotId, generatedAt: new Date().toISOString(), entries };
}

export function renderManifest(manifest: KbManifest): string {
  const lines = [
    `KNOWLEDGE BASE INDEX (snapshot: ${manifest.snapshotId}) — ${manifest.entries.length} files.`,
    "Read files with your tools before answering. Do not answer from these summaries alone.",
    "",
    ...manifest.entries.map((e) => `- ${e.path} — ${e.title}: ${e.summary}`),
  ];
  return lines.join("\n");
}
