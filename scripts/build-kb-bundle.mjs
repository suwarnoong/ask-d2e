#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export function buildCloneUrl(kbRepo, kbRepoToken) {
  return `https://x-access-token:${kbRepoToken}@github.com/${kbRepo}.git`;
}

export function cloneKbBundle({ url, branch, targetDir }) {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  execFileSync("git", ["clone", "--branch", branch, "--depth", "1", url, targetDir], { stdio: "inherit" });
}

function main() {
  const kbRepo = required("KB_REPO");
  const kbRepoToken = required("KB_REPO_TOKEN");
  const kbBranch = optional("KB_BRANCH", "main");
  const url = buildCloneUrl(kbRepo, kbRepoToken);

  try {
    cloneKbBundle({ url, branch: kbBranch, targetDir: "./knowledge-base" });
  } catch (err) {
    console.error(`Failed to clone KB repo ${kbRepo} (branch ${kbBranch}): ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
