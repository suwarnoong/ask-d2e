import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneAtRef, isShortSha } from "./snapshotSources.js";

test("isShortSha recognises the short pin form, not branches or tags", () => {
  assert.equal(isShortSha("269a00a"), true);
  // A full-length SHA needs no API resolution; git can fetch it directly.
  assert.equal(isShortSha("5ce42757279f969bca123f0128a5c967ff2e3bd4"), false);
  assert.equal(isShortSha("develop"), false);
  assert.equal(isShortSha("v0.18.1-beta"), false);
  assert.equal(isShortSha("webapi-3.0"), false);
});

test("cloneAtRef fetches a pinned commit that is not a branch or tag", async () => {
  // A local bare repo stands in for GitHub; no token is used on a path URL.
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q"], { cwd: seed });
  writeFileSync(join(seed, "README.md"), "# Pinned\n\nContent at the pinned commit.");
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: seed });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: seed });
  execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: seed });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim();

  const target = join(mkdtempSync(join(tmpdir(), "clone-")), "checkout");
  await cloneAtRef({ repo: origin, ref: sha, dir: target }, "unused-token");

  assert.ok(existsSync(join(target, "README.md")));
  assert.match(readFileSync(join(target, "README.md"), "utf8"), /pinned commit/);
});

test("cloneAtRef throws for a ref that cannot be fetched", async () => {
  const origin = mkdtempSync(join(tmpdir(), "origin2-"));
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const target = join(mkdtempSync(join(tmpdir(), "clone2-")), "checkout");
  await assert.rejects(() =>
    cloneAtRef({ repo: origin, ref: "0000000000000000000000000000000000000000", dir: target }, "t"),
  );
});
