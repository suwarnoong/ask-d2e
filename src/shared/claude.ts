import { spawn } from "node:child_process";
import type { ClaudeAuth } from "./config.js";

export interface CallClaudeOptions {
  cwd?: string;
  allowedTools?: string[];
  /** Override the spawned command; defaults to "claude". Test-only seam. */
  spawnCmd?: string;
}

export function parseClaudeCliOutput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI produced unparseable output: ${stdout.slice(0, 500)}`);
  }
  const result = (parsed as { result?: unknown } | null)?.result;
  if (typeof result !== "string" || result.trim() === "") {
    throw new Error(`claude CLI output missing a non-empty "result" field: ${stdout.slice(0, 500)}`);
  }
  return result;
}

export function callClaude(prompt: string, auth: ClaudeAuth, opts: CallClaudeOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!auth.claudeOauthToken) {
      reject(new Error("Missing CLAUDE_CODE_OAUTH_TOKEN"));
      return;
    }

    const args = ["-p", "--output-format", "json", "--model", auth.claudeModel];
    if (opts.allowedTools?.length) {
      args.push("--allowedTools", opts.allowedTools.join(","));
    }

    const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 120_000);
    const child = spawn(opts.spawnCmd ?? "claude", args, {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: auth.claudeOauthToken },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 1000)}`));
        return;
      }
      try {
        resolve(parseClaudeCliOutput(stdout));
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
