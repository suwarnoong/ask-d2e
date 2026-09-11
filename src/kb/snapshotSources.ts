import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

export interface CloneRequest {
  /** `owner/name`, or a local path in tests. */
  repo: string;
  /** Branch, tag or commit SHA. */
  ref: string;
  dir: string;
}

export type Cloner = (request: CloneRequest) => void | Promise<void>;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A 7–39 character hex ref is the short commit form stored in snapshots.json. */
export function isShortSha(ref: string): boolean {
  return /^[0-9a-f]{7,39}$/i.test(ref);
}

/**
 * GitHub refuses to fetch a *short* SHA ("couldn't find remote ref"), and Atlas3's pin is only
 * recoverable as a 7-character prefix from D2E's package.json. The API expands it to a full SHA,
 * which GitHub does serve.
 */
async function resolveRemoteRef(repo: string, ref: string, token: string): Promise<string> {
  if (!isShortSha(ref)) return ref;
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ask-d2e",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Could not resolve pinned ref "${ref}" in ${repo} (GitHub said ${response.status}).`,
    );
  }
  const sha = ((await response.json()) as { sha?: unknown }).sha;
  if (typeof sha !== "string" || sha === "") {
    throw new Error(`GitHub returned no commit SHA for "${ref}" in ${repo}.`);
  }
  return sha;
}

/**
 * Fetches exactly one ref and checks it out. Works for tags and bare commit SHAs alike, which
 * `git clone --branch` cannot do — Atlas3 and trex are pinned by commit. A missing ref throws
 * here, before the caller has written anything.
 */
export async function cloneAtRef(request: CloneRequest, token: string): Promise<void> {
  const isRemote = request.repo.includes("/") && !request.repo.startsWith("/");
  const url = isRemote ? `https://x-access-token:${token}@github.com/${request.repo}.git` : request.repo;
  const ref = isRemote ? await resolveRemoteRef(request.repo, request.ref, token) : request.ref;

  mkdirSync(request.dir, { recursive: true });
  git(request.dir, ["init", "-q"]);
  git(request.dir, ["remote", "add", "origin", url]);
  git(request.dir, ["fetch", "--depth", "1", "origin", ref]);
  git(request.dir, ["checkout", "-q", "FETCH_HEAD"]);
}
