import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

export interface CloneRequest {
  /** `owner/name`, or a local path in tests. */
  repo: string;
  /** Branch, tag or commit SHA. */
  ref: string;
  dir: string;
}

export type Cloner = (request: CloneRequest) => void;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Fetches exactly one ref and checks it out. Works for tags and bare commit SHAs alike, which
 * `git clone --branch` cannot do — Atlas3 and trex are pinned by commit. A missing ref throws
 * here, before the caller has written anything.
 */
export function cloneAtRef(request: CloneRequest, token: string): void {
  const isRemote = request.repo.includes("/") && !request.repo.startsWith("/");
  const url = isRemote ? `https://x-access-token:${token}@github.com/${request.repo}.git` : request.repo;

  mkdirSync(request.dir, { recursive: true });
  git(request.dir, ["init", "-q"]);
  git(request.dir, ["remote", "add", "origin", url]);
  git(request.dir, ["fetch", "--depth", "1", "origin", request.ref]);
  git(request.dir, ["checkout", "-q", "FETCH_HEAD"]);
}
