export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export function parseWebhooks(raw: string): string[] {
  const urls = raw.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    throw new Error("Slack webhook setting must contain at least one URL.");
  }
  return urls;
}

export function positiveNumber(name: string, fallback: string): number {
  const value = Number(optional(name, fallback));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

/** Model for a specific task: task-specific env var -> shared CLAUDE_MODEL -> hardcoded fallback. */
export function taskModel(taskEnv: string, fallback: string): string {
  return optional(taskEnv, optional("CLAUDE_MODEL", fallback));
}

export interface ClaudeAuth {
  claudeOauthToken: string;
  claudeModel: string;
}
