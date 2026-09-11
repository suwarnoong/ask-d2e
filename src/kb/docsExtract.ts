import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface ExtractedDoc {
  /** Path within the snapshot's docs/ directory. */
  outPath: string;
  /** Path within the source docs/website/docs/ tree. */
  sourcePath: string;
  title: string;
  content: string;
}

/** Where the docs site lives inside the Data2Evidence repository. */
export const DOCS_SOURCE_PREFIX = "docs/website/docs";

const IMPORT_RE = /^\s*import\s+.+?from\s+['"].+?['"];?\s*$/gm;
const EXPORT_RE = /^\s*export\s+(?:default|const)\s+.+$/gm;
const STANDALONE_JSX_RE = /^\s*<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>\s*$/gm;

/**
 * Removes MDX renderer syntax, keeping the prose. Only tags on their own line
 * and starting with a capital letter are removed, so inline HTML such as
 * <code> in running prose survives.
 */
export function stripMdx(body: string): string {
  return body
    .replace(IMPORT_RE, "")
    .replace(EXPORT_RE, "")
    .replace(STANDALONE_JSX_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LINK_RE = /\[([^\]]*)\]\((\.[^)\s]*)\)/g;

/** Rewrites ./ and ../ links to paths relative to the docs output root. */
export function rewriteRelativeLinks(body: string, sourcePath: string): string {
  const dir = posix.dirname(sourcePath);
  return body.replace(LINK_RE, (whole, label: string, href: string) => {
    const [target, hash = ""] = href.split("#");
    if (target === "") return whole;
    const resolved = posix.normalize(posix.join(dir, target));
    if (resolved.startsWith("..")) return whole;
    return `[${label}](${docOutputPath(resolved)}${hash ? `#${hash}` : ""})`;
  });
}

export function docOutputPath(sourcePath: string): string {
  return sourcePath.replace(/\.mdx$/, ".md").replace(/(^|\/)README\.md$/, "$1index.md");
}

export function extractDoc(sourcePath: string, raw: string): ExtractedDoc {
  const { data, body } = parseFrontmatter(raw);
  const stripped = rewriteRelativeLinks(stripMdx(body), sourcePath);
  const frontmatterTitle = typeof data.title === "string" ? data.title.trim() : "";
  const headingTitle = stripped.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? "";
  const title = frontmatterTitle || headingTitle || "(untitled)";
  const provenance = `<!-- source: ${DOCS_SOURCE_PREFIX}/${sourcePath} -->`;

  return {
    outPath: docOutputPath(sourcePath),
    sourcePath,
    title,
    content: `${provenance}\n\n${stripped}\n`,
  };
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

export function extractDocsTree(docsRoot: string): ExtractedDoc[] {
  const sourcePaths: string[] = [];
  try {
    walk(docsRoot, docsRoot, sourcePaths);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return sourcePaths
    .sort()
    .map((sourcePath) => extractDoc(sourcePath, readFileSync(join(docsRoot, sourcePath), "utf8")))
    .sort((a, b) => (a.outPath < b.outPath ? -1 : a.outPath > b.outPath ? 1 : 0));
}
