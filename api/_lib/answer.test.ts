import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllRepoKbs, answerQuestion, NO_KB_MATCH } from "./answer.js";

function makeFixtureRoot(repoNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "answer-root-"));
  for (const name of repoNames) {
    const dir = join(root, "repos", name, "knowledge-base", "00-overview");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intro.md"), `# ${name} intro\nSome content about ${name}.`);
  }
  return root;
}

test("readAllRepoKbs walks every configured repo's kb folder", () => {
  const root = makeFixtureRoot(["widgets", "gadgets"]);
  const files = readAllRepoKbs(root);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "repos/gadgets/knowledge-base/00-overview/intro.md",
    "repos/widgets/knowledge-base/00-overview/intro.md",
  ]);
});

test("answerQuestion returns covered=true for a normal answer", async () => {
  const stubClient = {
    messages: { create: async () => ({ content: [{ type: "text", text: "The answer is 42. Cited: repos/widgets/x.md" }] }) },
  };
  const result = await answerQuestion("what is the answer?", [], stubClient as any);
  assert.equal(result.covered, true);
  assert.ok(result.text.includes("42"));
});

test("answerQuestion requests a generous max_tokens so detailed answers aren't cut off", async () => {
  let capturedMaxTokens: number | undefined;
  const stubClient = {
    messages: {
      create: async (params: any) => {
        capturedMaxTokens = params.max_tokens;
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const originalEnv = process.env.ANSWER_MAX_TOKENS;
  delete process.env.ANSWER_MAX_TOKENS;
  try {
    await answerQuestion("anything", [], stubClient as any);
    assert.equal(capturedMaxTokens, 4096);
  } finally {
    if (originalEnv === undefined) delete process.env.ANSWER_MAX_TOKENS;
    else process.env.ANSWER_MAX_TOKENS = originalEnv;
  }
});

test("answerQuestion strips the NO_KB_MATCH sentinel and reports covered=false", async () => {
  const stubClient = {
    messages: { create: async () => ({ content: [{ type: "text", text: `${NO_KB_MATCH}\nSorry, nothing covers that.` }] }) },
  };
  const result = await answerQuestion("something obscure", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.equal(result.text.trim(), "Sorry, nothing covers that.");
});

test("answerQuestion strips a markdown-bolded NO_KB_MATCH sentinel (observed production format)", async () => {
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "**NO_KB_MATCH\n\nThe knowledge base doesn't contain information about HANA databases in general..." }],
      }),
    },
  };
  const result = await answerQuestion("tell me about HANA database", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.ok(!result.text.includes("NO_KB_MATCH"));
  assert.ok(result.text.startsWith("The knowledge base"));
});

test("answerQuestion strips NO_KB_MATCH even when the model doesn't lead with it", async () => {
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "Based on the knowledge base: NO_KB_MATCH The docs don't cover HANA in general, but here's what's there about D2E's use of it." }],
      }),
    },
  };
  const result = await answerQuestion("tell me about HANA database", [], stubClient as any);
  assert.equal(result.covered, false);
  assert.ok(!result.text.includes("NO_KB_MATCH"));
  assert.ok(result.text.includes("Based on the knowledge base:"));
  assert.ok(result.text.includes("The docs don't cover HANA"));
});

import { answerQuestion as answerQuestionRetrieval } from "./answer.js";
import type { AnthropicLikeResponse } from "../../src/shared/anthropicLike.js";

test("answerQuestion declares the KB tools and returns the model's text", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        calls.push(args[0] as Record<string, unknown>);
        return { content: [{ type: "text", text: "Use the CLI." }], stop_reason: "end_turn" };
      },
    },
  };

  const result = await answerQuestionRetrieval("how?", [], client);

  assert.equal(result.text, "Use the CLI.");
  assert.equal(result.covered, true);
  assert.deepEqual(result.filesRead, []);
  assert.equal(result.truncated, false);
  assert.ok(Array.isArray(calls[0].tools), "tools must be declared");
});

test("answerQuestion puts the manifest in the system prompt, not the KB body", async () => {
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  await answerQuestionRetrieval("how?", [], client);

  assert.match(systemText, /KNOWLEDGE BASE INDEX/);
  assert.doesNotMatch(systemText, /===== FILE:/);
});

test("answerQuestion still strips the NO_KB_MATCH sentinel", async () => {
  const client = {
    messages: {
      create: async (): Promise<AnthropicLikeResponse> => ({
        content: [{ type: "text", text: `${NO_KB_MATCH}\nNot covered here.` }],
        stop_reason: "end_turn",
      }),
    },
  };

  const result = await answerQuestionRetrieval("what?", [], client);

  assert.equal(result.covered, false);
  assert.equal(result.text, "Not covered here.");
  assert.doesNotMatch(result.text, /NO_KB_MATCH/);
});

test("answerQuestion surfaces truncation from the retrieval loop", async () => {
  let call = 0;
  const client = {
    messages: {
      create: async (): Promise<AnthropicLikeResponse> => {
        call++;
        if (call === 1) {
          return {
            content: [{ type: "tool_use", id: "t", name: "list_kb_dir", input: { path: "curated" } }],
            stop_reason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "Partial." }], stop_reason: "end_turn" };
      },
    },
  };

  const prev = process.env.RETRIEVAL_MAX_TURNS;
  process.env.RETRIEVAL_MAX_TURNS = "1";
  try {
    const result = await answerQuestionRetrieval("what?", [], client);
    assert.equal(result.truncated, true);
    assert.equal(result.text, "Partial.");
  } finally {
    if (prev === undefined) delete process.env.RETRIEVAL_MAX_TURNS;
    else process.env.RETRIEVAL_MAX_TURNS = prev;
  }
});

import { mkdtempSync as mkdtemp2, mkdirSync as mkdir2, writeFileSync as write2 } from "node:fs";

function rootWithFaq(): string {
  const root = mkdtemp2(join(tmpdir(), "answer-faq-"));
  const dir = join(root, "curated", "faq");
  mkdir2(dir, { recursive: true });
  write2(
    join(dir, "faq-03.md"),
    [
      "---",
      "id: faq-03",
      "question: What support does Data4Life provide?",
      "owner: project-manager",
      "lastReviewed: 2026-09-11",
      "---",
      "No 24/7 SLA. Community support only.",
    ].join("\n"),
  );
  return root;
}

test("the curated FAQ is shipped whole in the system prompt", async () => {
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = rootWithFaq();
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  try {
    await answerQuestionRetrieval("what support?", [], client);
    assert.match(systemText, /CURATED FAQ \(TIER 1/);
    assert.match(systemText, /No 24\/7 SLA\. Community support only\./);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});

test("the system prompt states tier precedence and the decline rule", async () => {
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = rootWithFaq();
  let systemText = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[] };
        systemText = body.system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };

  try {
    await answerQuestionRetrieval("anything", [], client);
    assert.match(systemText, /TIER PRECEDENCE/);
    assert.match(systemText, /decline/i);
    assert.match(systemText, /contract specification/i);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});
