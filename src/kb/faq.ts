import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.js";

export interface FaqEntry {
  id: string;
  question: string;
  tags: string[];
  owner: string;
  lastReviewed: string;
  verifiableClaims: { claim: string }[];
  body: string;
  /** Repo-relative path, used verbatim as the citation. */
  path: string;
}

const REQUIRED_SCALARS = ["id", "question", "owner", "lastReviewed"] as const;

function scalar(
  data: Record<string, FrontmatterValue>,
  key: string,
  relPath: string,
): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${relPath}: frontmatter field "${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function parseFaqFile(relPath: string, raw: string): FaqEntry {
  const { data, body } = parseFrontmatter(raw);
  for (const key of REQUIRED_SCALARS) scalar(data, key, relPath);
  if (body.trim() === "") {
    throw new Error(`${relPath}: FAQ entry has an empty body.`);
  }
  const tags = Array.isArray(data.tags) ? (data.tags as string[]).filter((t) => typeof t === "string") : [];
  const claims = Array.isArray(data.verifiableClaims)
    ? (data.verifiableClaims as { claim: string }[]).filter((c) => c && typeof c.claim === "string")
    : [];

  return {
    id: scalar(data, "id", relPath),
    question: scalar(data, "question", relPath),
    owner: scalar(data, "owner", relPath),
    lastReviewed: scalar(data, "lastReviewed", relPath),
    tags,
    verifiableClaims: claims,
    body: body.trim(),
    path: relPath,
  };
}

export function loadFaq(kbRoot: string): FaqEntry[] {
  const dir = join(kbRoot, "curated", "faq");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .sort()
    .map((name) => parseFaqFile(`curated/faq/${name}`, readFileSync(join(dir, name), "utf8")))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function renderFaqForPrompt(entries: FaqEntry[]): string {
  if (entries.length === 0) {
    return "CURATED FAQ (TIER 1): there are no curated FAQ entries configured.";
  }
  const header = [
    `CURATED FAQ (TIER 1 — HIGHEST AUTHORITY, ${entries.length} entries).`,
    "Human-authored and reviewed. For questions about legal terms, licensing, pricing,",
    "support commitments, or company policy, answer from these entries ONLY, staying close",
    "to the wording below. Never infer such an answer from code or documentation, and never",
    "extend a commitment these entries do not make. Cite the entry's path.",
    "",
  ].join("\n");

  const body = entries
    .map((e) => [`--- ${e.path} ---`, `Q: ${e.question}`, `A: ${e.body}`].join("\n"))
    .join("\n\n");

  return `${header}${body}`;
}
