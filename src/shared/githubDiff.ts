import { Octokit } from "@octokit/rest";

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  labels: string[];
  body_excerpt: string;
  files: string[];
  diff: string;
  diff_truncated: boolean;
}

export interface AuthorGroup {
  author: string;
  prCount: number;
  additions: number;
  deletions: number;
  prs: number[];
}

export interface DigestData {
  repo: string;
  since: string;
  generatedAt: string;
  prs: PrSummary[];
  byAuthor: AuthorGroup[];
  totals: { prCount: number; authorCount: number; additions: number; deletions: number };
}

export interface RawPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface RawPr {
  number: number;
  title: string;
  user?: { login?: string } | null;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  labels?: Array<{ name?: string }>;
  body?: string | null;
  merged_at?: string | null;
}

/** All network calls go through this interface. Tests can then replace Octokit. */
export interface GithubClient {
  searchMergedPrNumbers(sourceRepo: string, sinceIso: string): Promise<number[]>;
  getPr(sourceRepo: string, prNumber: number): Promise<RawPr>;
  listPrFiles(sourceRepo: string, prNumber: number): Promise<RawPrFile[]>;
}

export const DIFF_CHAR_CAP = 24_000;
export const BODY_EXCERPT_CAP = 280;

export function splitRepo(sourceRepo: string): [string, string] {
  const [owner, repo] = sourceRepo.split("/");
  if (!owner || !repo) throw new Error(`sourceRepo must be "owner/name", got "${sourceRepo}"`);
  return [owner, repo];
}

export function bodyExcerpt(body: string | null | undefined, cap = BODY_EXCERPT_CAP): string {
  const collapsed = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "") // Most of a PR template is HTML comments. Remove all of them.
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= cap ? collapsed : collapsed.slice(0, cap).trimEnd() + "…";
}

export function buildPrDiff(files: RawPrFile[], cap = DIFF_CHAR_CAP): { diff: string; truncated: boolean } {
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const block = `### ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})\n${
      f.patch ?? "(binary file or no patch available)"
    }`;
    if (used + block.length > cap) {
      blocks.push(`### …and ${files.length - i} more file(s) not shown (diff size cap reached)`);
      return { diff: blocks.join("\n\n"), truncated: true };
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return { diff: blocks.join("\n\n"), truncated: false };
}

export function groupByAuthor(prs: PrSummary[]): AuthorGroup[] {
  const groups = new Map<string, AuthorGroup>();
  for (const pr of prs) {
    let g = groups.get(pr.author);
    if (!g) {
      g = { author: pr.author, prCount: 0, additions: 0, deletions: 0, prs: [] };
      groups.set(pr.author, g);
    }
    g.prCount++;
    g.additions += pr.additions;
    g.deletions += pr.deletions;
    g.prs.push(pr.number);
  }
  return [...groups.values()].sort(
    (a, b) => b.prCount - a.prCount || b.additions + b.deletions - (a.additions + a.deletions),
  );
}

export function createOctokitClient(githubToken: string): GithubClient {
  const octokit = new Octokit({ auth: githubToken });
  return {
    async searchMergedPrNumbers(sourceRepo, sinceIso) {
      const items = await octokit.paginate(octokit.rest.search.issuesAndPullRequests, {
        q: `repo:${sourceRepo} is:pr is:merged merged:>=${sinceIso}`,
        per_page: 100,
        // The new search backend needs this parameter. The types do not include it yet.
        advanced_search: "true",
      } as Parameters<typeof octokit.rest.search.issuesAndPullRequests>[0]);
      return items.map((i) => i.number);
    },
    async getPr(sourceRepo, prNumber) {
      const [owner, repo] = splitRepo(sourceRepo);
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return data as RawPr;
    },
    async listPrFiles(sourceRepo, prNumber) {
      const [owner, repo] = splitRepo(sourceRepo);
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return files as RawPrFile[];
    },
  };
}

export async function gatherRepoPrs(
  sourceRepo: string,
  sinceIso: string,
  githubToken: string,
  client: GithubClient = createOctokitClient(githubToken),
): Promise<DigestData> {
  const sinceMs = new Date(sinceIso).getTime();
  const numbers = await client.searchMergedPrNumbers(sourceRepo, sinceIso);

  const prs: PrSummary[] = [];
  for (const number of numbers) {
    // Search results do not give additions, deletions, or changed_files. Get the full PR.
    const raw = await client.getPr(sourceRepo, number);
    // The `merged:>=` filter is accurate only to the day. Remove the PRs that are too old.
    if (raw.merged_at && new Date(raw.merged_at).getTime() < sinceMs) continue;

    const files = await client.listPrFiles(sourceRepo, number);
    const { diff, truncated } = buildPrDiff(files);
    prs.push({
      number: raw.number,
      title: raw.title,
      author: raw.user?.login ?? "unknown",
      html_url: raw.html_url,
      additions: raw.additions,
      deletions: raw.deletions,
      changed_files: raw.changed_files,
      labels: (raw.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      body_excerpt: bodyExcerpt(raw.body),
      files: files.map((f) => f.filename),
      diff,
      diff_truncated: truncated,
    });
  }

  const byAuthor = groupByAuthor(prs);
  return {
    repo: sourceRepo,
    since: sinceIso,
    generatedAt: new Date().toISOString(),
    prs,
    byAuthor,
    totals: {
      prCount: prs.length,
      authorCount: byAuthor.length,
      additions: prs.reduce((n, p) => n + p.additions, 0),
      deletions: prs.reduce((n, p) => n + p.deletions, 0),
    },
  };
}
