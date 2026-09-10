export interface KbChange {
  path: string;
  action: "update" | "create";
  rationale: string;
  source_prs: number[];
  content: string;
}

export interface KbPlan {
  summary: string;
  changes: KbChange[];
}

export function stripFences(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : text.trim();
}

/** Return the balanced {...} substring starting at `start`, string-literal aware. */
export function balancedFrom(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    candidates.push(m[1].trim());
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const candidate = balancedFrom(text, i);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

function isValidChange(x: unknown): x is KbChange {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  if (typeof c.path !== "string" || c.path.trim() === "") return false;
  if (c.action !== "update" && c.action !== "create") return false;
  if (typeof c.content !== "string" || c.content.trim() === "") return false;
  if (c.source_prs !== undefined && !(Array.isArray(c.source_prs) && c.source_prs.every((n) => typeof n === "number"))) return false;
  return true;
}

export function parseKbResponse(text: string): KbPlan {
  const attempts = [stripFences(text), ...jsonCandidates(text)];
  for (const attempt of attempts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.changes)) continue;
    if (!obj.changes.every(isValidChange)) continue;
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      changes: (obj.changes as KbChange[]).map((c) => ({ ...c, source_prs: c.source_prs ?? [] })),
    };
  }
  throw new Error(`No valid KbPlan JSON (with a valid "changes" array) found in response: ${text.slice(0, 500)}`);
}
