import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join, sep, relative } from "node:path";
import type { KbChange } from "./responseParsing.js";

export function safeRepoKbPath(kbRoot: string, repoName: string, relPath: string): string {
  const repoRoot = resolve(kbRoot, "repos", repoName, "knowledge-base");
  const target = resolve(kbRoot, relPath);
  if (target !== repoRoot && !target.startsWith(repoRoot + sep)) {
    throw new Error(`Refusing to write outside repos/${repoName}/knowledge-base/: "${relPath}"`);
  }
  if (!target.endsWith(".md")) {
    throw new Error(`Refusing to write a non-markdown file: "${relPath}"`);
  }
  return target;
}

export interface KbFile {
  path: string;
  content: string;
}

function walkMarkdown(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkMarkdown(full, root, out);
    } else if (entry.endsWith(".md")) {
      out.push(relative(root, full));
    }
  }
}

export function readRepoKb(kbRoot: string, repoName: string): KbFile[] {
  const repoRoot = resolve(kbRoot, "repos", repoName, "knowledge-base");
  const relPaths: string[] = [];
  try {
    walkMarkdown(repoRoot, kbRoot, relPaths);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  relPaths.sort();
  return relPaths.map((relPath) => ({
    path: relPath.split(sep).join("/"),
    content: readFileSync(resolve(kbRoot, relPath), "utf8"),
  }));
}

const DEFAULT_KB_CONTENT_BUDGET = 600_000;

export function renderKb(files: KbFile[], budget = DEFAULT_KB_CONTENT_BUDGET): string {
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total <= budget) {
    return files.map((f) => `===== FILE: ${f.path} =====\n${f.content}`).join("\n\n");
  }
  const lines = [
    "WARNING: this repo's knowledge base exceeds the content budget — showing a path + heading index only.",
    "Be conservative about editing files you cannot see in full; re-read a file with your tools before changing it.",
    "",
  ];
  for (const f of files) {
    const heading = f.content.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? "(no heading found)";
    lines.push(`- ${f.path}: ${heading}`);
  }
  return lines.join("\n");
}

export function applyKbChanges(changes: KbChange[], kbRoot: string, repoName: string): string[] {
  const targets = changes.map((c) => ({
    change: c,
    absPath: safeRepoKbPath(kbRoot, repoName, c.path),
  }));
  for (const { absPath } of targets) {
    mkdirSync(resolve(absPath, ".."), { recursive: true });
  }
  for (const { change, absPath } of targets) {
    const content = change.content.endsWith("\n") ? change.content : change.content + "\n";
    writeFileSync(absPath, content);
  }
  return targets.map((t) => t.change.path);
}
