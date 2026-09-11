import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { extractDocsTree, type ExtractedDoc } from "./docsExtract.js";
import { buildTroubleshootingIndex, renderTroubleshootingIndex } from "./troubleshooting.js";
import { buildManifest, renderManifest } from "./manifest.js";
import type { KbFile } from "./kbFiles.js";

export interface BuildDocsTierOptions {
  /** Absolute path to a checkout's docs/website/docs directory. */
  docsRoot: string;
  /** Absolute path to the ask-d2e-kb working copy. */
  kbRoot: string;
  snapshotId: string;
}

export interface BuildDocsTierResult {
  docsWritten: number;
  troubleshootingEntries: number;
  manifestEntries: number;
  outputDir: string;
}

const SUMMARY_MAX = 160;

/** First real prose line of a doc, for the manifest. Deterministic by design. */
export function summariseDoc(doc: ExtractedDoc): string {
  const line = doc.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("<!--"));
  if (!line) return doc.title;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line;
}

function safeSnapshotPath(kbRoot: string, snapshotId: string, relPath: string): string {
  const snapshotRoot = resolve(kbRoot, "snapshots", snapshotId);
  const target = resolve(snapshotRoot, relPath);
  if (!target.startsWith(snapshotRoot + sep)) {
    throw new Error(`Refusing to write outside snapshots/${snapshotId}/: "${relPath}"`);
  }
  return target;
}

function write(kbRoot: string, snapshotId: string, relPath: string, content: string): void {
  const abs = safeSnapshotPath(kbRoot, snapshotId, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content.endsWith("\n") ? content : `${content}\n`);
}

export function buildDocsTier(options: BuildDocsTierOptions): BuildDocsTierResult {
  const { docsRoot, kbRoot, snapshotId } = options;
  const outputDir = resolve(kbRoot, "snapshots", snapshotId);
  const docs = extractDocsTree(docsRoot);

  if (docs.length === 0) {
    return { docsWritten: 0, troubleshootingEntries: 0, manifestEntries: 0, outputDir };
  }

  for (const doc of docs) {
    write(kbRoot, snapshotId, `docs/${doc.outPath}`, doc.content);
  }

  const troubleshooting = buildTroubleshootingIndex(docs);
  const troubleshootingText = renderTroubleshootingIndex(troubleshooting);
  write(kbRoot, snapshotId, "troubleshooting.md", troubleshootingText);

  // Manifest paths are repo-relative so the retrieval tools accept them verbatim.
  const manifestFiles: KbFile[] = [
    ...docs.map((doc) => ({
      path: `snapshots/${snapshotId}/docs/${doc.outPath}`,
      content: doc.content,
    })),
    {
      path: `snapshots/${snapshotId}/troubleshooting.md`,
      content: troubleshootingText,
    },
  ];
  const summaries = new Map(
    docs.map((doc) => [`snapshots/${snapshotId}/docs/${doc.outPath}`, summariseDoc(doc)]),
  );
  const manifest = buildManifest(snapshotId, manifestFiles, (file) =>
    summaries.get(file.path) ??
    `Known symptoms and resolutions from the official documentation (${troubleshooting.length} entries).`,
  );
  write(kbRoot, snapshotId, "manifest.json", JSON.stringify(manifest, null, 2));

  console.log(renderManifest(manifest).split("\n").slice(0, 2).join("\n"));

  return {
    docsWritten: docs.length,
    troubleshootingEntries: troubleshooting.length,
    manifestEntries: manifest.entries.length,
    outputDir,
  };
}
