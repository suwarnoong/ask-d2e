export type Block =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | { type: "divider" }
  | { type: "actions"; elements: unknown[] };

export function chunkText(text: string, limit = 2900): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  function flush() {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  }

  for (const line of lines) {
    let remaining = line;
    // A single line longer than the limit must be hard-split on its own.
    while (remaining.length > limit) {
      flush();
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    const candidate = current.length === 0 ? remaining : current + "\n" + remaining;
    if (candidate.length > limit) {
      flush();
      current = remaining;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

/** Split text into segments, applying `transform` only to non-code segments. */
function transformOutsideCode(text: string, transform: (s: string) => string): string {
  const fenceProtected: string[] = [];
  let withoutFences = text.replace(FENCE_RE, (m) => {
    fenceProtected.push(m);
    return ` FENCE${fenceProtected.length - 1} `;
  });

  const inlineProtected: string[] = [];
  withoutFences = withoutFences.replace(INLINE_CODE_RE, (m) => {
    inlineProtected.push(m);
    return ` CODE${inlineProtected.length - 1} `;
  });

  let result = transform(withoutFences);

  result = result.replace(/ CODE(\d+) /g, (_, i) => inlineProtected[Number(i)]);
  result = result.replace(/ FENCE(\d+) /g, (_, i) => fenceProtected[Number(i)]);
  return result;
}

function splitTableRow(row: string): string[] {
  return row
    .split("|")
    .map((c) => c.trim())
    .filter((_, idx, arr) => !(idx === 0 && arr[0] === "") && !(idx === arr.length - 1 && arr[arr.length - 1] === ""));
}

function convertGfmTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (header?.includes("|") && delim && /^\s*\|?[\s:|-]+\|?\s*$/.test(delim) && delim.includes("-")) {
      const rawRows: string[] = [header];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|")) {
        rawRows.push(lines[j]);
        j++;
      }
      const parsedRows = rawRows.map(splitTableRow);
      const colWidths = parsedRows[0].map((_, colIdx) => Math.max(...parsedRows.map((r) => (r[colIdx] ?? "").length)));
      const rendered = parsedRows
        .map((r) => r.map((c, colIdx) => c.padEnd(colWidths[colIdx])).join("  "))
        .join("\n");
      out.push("```\n" + rendered + "\n```");
      i = j;
    } else {
      out.push(header);
      i++;
    }
  }
  return out.join("\n");
}

export function toSlackMrkdwn(md: string): string {
  return transformOutsideCode(md, (text) => {
    let out = convertGfmTables(text);
    out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
    out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
    out = out.replace(/__(.+?)__/g, "*$1*");
    out = out.replace(/~~(.+?)~~/g, "~$1~");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
    return out;
  });
}

export function headerDate(iso: string, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric", timeZone };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(iso));
  }
}

export async function postBlocks(webhookUrls: string[], blocks: Block[], fallbackText: string): Promise<void> {
  const results = await Promise.allSettled(
    webhookUrls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: fallbackText, blocks }),
      }).then((res) => {
        if (!res.ok) throw new Error(`webhook post failed: ${res.status}`);
      }),
    ),
  );
  if (results.every((r) => r.status === "rejected")) {
    throw new Error(`All ${webhookUrls.length} Slack webhook(s) failed to post.`);
  }
}

export async function postThreadReply(opts: {
  botToken: string;
  channel: string;
  thread_ts: string;
  blocks: Block[];
  fallbackText: string;
}): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.botToken}`,
    },
    body: JSON.stringify({
      channel: opts.channel,
      thread_ts: opts.thread_ts,
      text: opts.fallbackText,
      blocks: opts.blocks,
    }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`chat.postMessage failed: ${data.error}`);
  }
}
