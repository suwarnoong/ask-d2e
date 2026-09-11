import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveScopedPath, type KbScope } from "../../src/kb/kbScope.js";

export interface KbToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface KbToolResult {
  content: string;
  isError: boolean;
  bytes: number;
}

const MAX_PATTERN_LENGTH = 200;
const MAX_GREP_MATCHES = 50;

export const KB_TOOL_DEFS: KbToolDef[] = [
  {
    name: "read_kb_file",
    description:
      "Read one knowledge-base file in full. Use the exact path shown in the index. " +
      "Always read a file before making a claim about its contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. snapshots/develop/docs/setup/cli.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_kb",
    description:
      "Search the knowledge base with a JavaScript regular expression. Returns matching " +
      "lines with their file and line number. Use this to locate an error message, a " +
      "config key, or a term you cannot place from the index alone.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source, max 200 chars" },
        pathPrefix: { type: "string", description: "Optional repo-relative prefix to narrow the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_kb_dir",
    description:
      "List the entries of one knowledge-base directory. Directory names end with a slash. " +
      "Use this to explore an area the index summarises only loosely.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative directory path" },
      },
      required: ["path"],
    },
  },
];

function ok(content: string): KbToolResult {
  return { content, isError: false, bytes: content.length };
}

function fail(content: string): KbToolResult {
  return { content, isError: true, bytes: content.length };
}

function stringArg(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readKbFile(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const path = stringArg(input, "path");
  if (!path) return fail('read_kb_file requires a non-empty string "path".');
  let abs: string;
  try {
    abs = resolveScopedPath(scope, path);
  } catch (err) {
    return fail((err as Error).message);
  }
  try {
    return ok(readFileSync(abs, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(`File not found: ${path}. Check the index for the exact path.`);
    }
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      return fail(`${path} is a directory. Use list_kb_dir instead.`);
    }
    return fail(`Could not read ${path}: ${(err as Error).message}`);
  }
}

function collectMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
}

function searchFiles(files: string[], re: RegExp, kbRoot: string): string[] {
  const matches: string[] = [];
  for (const abs of files.sort()) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(kbRoot, abs).split(sep).join("/");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (re.test(lines[i])) matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  return matches;
}

function grepKb(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const pattern = stringArg(input, "pattern");
  if (!pattern) return fail('grep_kb requires a non-empty string "pattern".');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return fail(`Pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH}).`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return fail(`Invalid regular expression: ${(err as Error).message}`);
  }

  const prefix = stringArg(input, "pathPrefix");
  const searchRoots = prefix
    ? [prefix]
    : scope.allowedPrefixes;

  const files: string[] = [];
  for (const root of searchRoots) {
    let abs: string;
    try {
      abs = resolveScopedPath(scope, root);
    } catch (err) {
      return fail((err as Error).message);
    }
    collectMarkdown(abs, files);
  }

  const matches = searchFiles(files, re, scope.kbRoot);

  if (matches.length === 0) return ok(`No matches for /${pattern}/.`);
  const truncated =
    matches.length >= MAX_GREP_MATCHES
      ? `\n(truncated at ${MAX_GREP_MATCHES} matches — narrow the pattern or set pathPrefix)`
      : "";
  return ok(matches.join("\n") + truncated);
}

function listKbDir(input: Record<string, unknown>, scope: KbScope): KbToolResult {
  const path = stringArg(input, "path");
  if (!path) return fail('list_kb_dir requires a non-empty string "path".');
  let abs: string;
  try {
    abs = resolveScopedPath(scope, path);
  } catch (err) {
    return fail((err as Error).message);
  }
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(`Directory not found: ${path}`);
    }
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return fail(`${path} is a file. Use read_kb_file instead.`);
    }
    return fail(`Could not list ${path}: ${(err as Error).message}`);
  }
  if (entries.length === 0) return ok(`${path} is empty.`);
  const rendered = entries.sort().map((entry) => {
    const isDir = statSync(join(abs, entry)).isDirectory();
    return isDir ? `${entry}/` : entry;
  });
  return ok(rendered.join("\n"));
}

export function executeKbTool(
  name: string,
  input: Record<string, unknown>,
  scope: KbScope,
): KbToolResult {
  switch (name) {
    case "read_kb_file":
      return readKbFile(input, scope);
    case "grep_kb":
      return grepKb(input, scope);
    case "list_kb_dir":
      return listKbDir(input, scope);
    default:
      return fail(`Unknown tool "${name}". Available: read_kb_file, grep_kb, list_kb_dir.`);
  }
}
