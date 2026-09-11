export type FrontmatterValue = string | string[] | { claim: string }[];

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const DELIMITER = "---";

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map(unquote).filter((item) => item !== "");
}

/**
 * Parses the restricted frontmatter subset the curated FAQ uses. Deliberately
 * strict: anything outside the subset throws, so a malformed file fails the
 * build rather than silently losing its verifiable claims.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== DELIMITER) {
    return { data: {}, body: raw.trim() };
  }

  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === DELIMITER);
  if (closing === -1) {
    throw new Error("Unterminated frontmatter block: no closing --- found.");
  }

  const data: Record<string, FrontmatterValue> = {};
  let currentListKey: string | null = null;

  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ")) {
      if (currentListKey === null) {
        throw new Error(`Unsupported frontmatter line (list item with no key): "${trimmed}"`);
      }
      const item = trimmed.slice(2).trim();
      const claimMatch = item.match(/^claim:\s*(.+)$/);
      if (!claimMatch) {
        throw new Error(`Unsupported frontmatter list item (expected "claim: ..."): "${item}"`);
      }
      (data[currentListKey] as { claim: string }[]).push({ claim: unquote(claimMatch[1]) });
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`Unsupported frontmatter line: "${trimmed}"`);
    }
    const [, key, rest] = keyMatch;

    if (rest === "") {
      data[key] = [] as { claim: string }[];
      currentListKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = parseInlineList(rest);
      currentListKey = null;
    } else {
      data[key] = unquote(rest);
      currentListKey = null;
    }
  }

  return { data, body: lines.slice(closing + 1).join("\n").trim() };
}
