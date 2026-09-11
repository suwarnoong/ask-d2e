import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { KbChange } from "./responseParsing.js";

function assertMarkdown(relPath: string): void {
  if (!relPath.endsWith(".md")) {
    throw new Error(`Refusing to write a non-markdown file: "${relPath}"`);
  }
}

function writeAll(
  targets: { change: KbChange; absPath: string }[],
): string[] {
  for (const { absPath } of targets) mkdirSync(resolve(absPath, ".."), { recursive: true });
  for (const { change, absPath } of targets) {
    writeFileSync(absPath, change.content.endsWith("\n") ? change.content : `${change.content}\n`);
  }
  return targets.map((t) => t.change.path);
}

/** The write guard for `snapshots/<id>/generated/<repo>/`. Mirrors safeRepoKbPath's discipline. */
export function safeSnapshotGeneratedPath(
  kbRoot: string,
  snapshotId: string,
  repoName: string,
  relPath: string,
): string {
  const targetRoot = resolve(kbRoot, "snapshots", snapshotId, "generated", repoName);
  const target = resolve(kbRoot, relPath);
  if (target === targetRoot || !target.startsWith(targetRoot + sep)) {
    throw new Error(
      `Refusing to write outside snapshots/${snapshotId}/generated/${repoName}/: "${relPath}"`,
    );
  }
  assertMarkdown(relPath);
  return target;
}

export function applySnapshotKbChanges(
  changes: KbChange[],
  kbRoot: string,
  snapshotId: string,
  repoName: string,
): string[] {
  return writeAll(
    changes.map((change) => ({
      change,
      absPath: safeSnapshotGeneratedPath(kbRoot, snapshotId, repoName, change.path),
    })),
  );
}

/** The shared, version-independent WebAPI contract tier. */
export function safeSharedContractPath(kbRoot: string, relPath: string): string {
  const targetRoot = resolve(kbRoot, "repos", "_shared", "webapi-contract");
  const target = resolve(kbRoot, relPath);
  if (target === targetRoot || !target.startsWith(targetRoot + sep)) {
    throw new Error(`Refusing to write outside repos/_shared/webapi-contract/: "${relPath}"`);
  }
  assertMarkdown(relPath);
  return target;
}

export function applySharedContractChanges(changes: KbChange[], kbRoot: string): string[] {
  return writeAll(
    changes.map((change) => ({
      change,
      absPath: safeSharedContractPath(kbRoot, change.path),
    })),
  );
}
