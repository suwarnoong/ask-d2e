import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { KbFile } from "./kbFiles.js";
import { buildManifest, extractTitle, type KbManifest } from "./manifest.js";
import { summariseDoc } from "./buildDocsTier.js";

function walkMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
}

/** Every markdown file a snapshot holds, as repo-relative paths. */
export function collectSnapshotFiles(kbRoot: string, snapshotId: string): KbFile[] {
  const snapshotDir = join(kbRoot, "snapshots", snapshotId);
  const absolute: string[] = [];
  walkMarkdown(join(snapshotDir, "docs"), absolute);
  walkMarkdown(join(snapshotDir, "generated"), absolute);

  const troubleshooting = join(snapshotDir, "troubleshooting.md");
  try {
    readFileSync(troubleshooting);
    absolute.push(troubleshooting);
  } catch {
    // No troubleshooting index — a snapshot without one is still indexable.
  }

  return absolute.sort().map((abs) => ({
    path: relative(kbRoot, abs).split(sep).join("/"),
    content: readFileSync(abs, "utf8"),
  }));
}

export function rebuildSnapshotManifest(kbRoot: string, snapshotId: string): KbManifest {
  const files = collectSnapshotFiles(kbRoot, snapshotId);
  const manifest = buildManifest(snapshotId, files, (file) =>
    summariseDoc({
      outPath: file.path,
      sourcePath: file.path,
      title: extractTitle(file.content),
      content: file.content,
    }),
  );
  writeFileSync(
    join(kbRoot, "snapshots", snapshotId, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
