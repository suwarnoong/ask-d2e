import { resolve, sep } from "node:path";

export interface KbScope {
  kbRoot: string;
  /** Repo-relative path prefixes the scope may read from. */
  allowedPrefixes: string[];
}

/**
 * Read scope for answering against one snapshot: that snapshot's own content,
 * plus the version-independent shared tiers (the WebAPI contract and the
 * curated FAQ).
 */
export function scopeForSnapshot(kbRoot: string, snapshotId: string): KbScope {
  return {
    kbRoot,
    allowedPrefixes: [`snapshots/${snapshotId}`, "repos/_shared", "curated"],
  };
}

function resolveIfAllowed(scope: KbScope, relPath: string): string | null {
  const root = resolve(scope.kbRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return scope.allowedPrefixes.some((prefix) => {
    const allowed = resolve(root, prefix);
    return target === allowed || target.startsWith(allowed + sep);
  })
    ? target
    : null;
}

export function isWithinScope(scope: KbScope, relPath: string): boolean {
  return resolveIfAllowed(scope, relPath) !== null;
}

export function resolveScopedPath(scope: KbScope, relPath: string): string {
  const target = resolveIfAllowed(scope, relPath);
  if (target === null) {
    throw new Error(
      `Refusing to read a path outside the allowed scope (${scope.allowedPrefixes.join(", ")}): "${relPath}".`,
    );
  }
  return target;
}
