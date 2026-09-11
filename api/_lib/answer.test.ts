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

import { writeFileSync as writeSnapshots } from "node:fs";

function rootWithSnapshots(): string {
  const root = mkdtemp2(join(tmpdir(), "answer-snapshots-"));
  writeSnapshots(
    join(root, "snapshots.json"),
    JSON.stringify({
      snapshots: [
        { id: "develop", d2eTag: "develop", pins: { atlas3: "269a00a", trex: "5ce4275" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: true },
        { id: "v0.18.1-beta", d2eTag: "v0.18.1-beta", pins: { atlas3: "9baa99a", trex: "dec4a95" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: false },
        { id: "v0.18.0-beta", d2eTag: "v0.18.0-beta", pins: { atlas3: "9baa99a", trex: "2988da6" }, status: "active", builtAt: "2026-09-11T00:00:00.000Z", isDevelop: false },
      ],
    }),
  );
  return root;
}

async function systemPromptFor(question: string, root: string): Promise<{ system: string; question: string }> {
  let system = "";
  let asked = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        const body = args[0] as { system: { text: string }[]; messages: { content: unknown }[] };
        if (!system) {
          system = body.system.map((s) => s.text).join("\n");
          asked = String(body.messages[body.messages.length - 1].content);
        }
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = root;
  try {
    await answerQuestionRetrieval(question, [], client);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
  return { system, question: asked };
}

test("an inline version override routes to that snapshot and is stripped from the question", async () => {
  const { system, question } = await systemPromptFor("v0.18.1 how do I start?", rootWithSnapshots());
  assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.1-beta\)/);
  assert.equal(question, "how do I start?");
});

test("a question with no override uses develop", async () => {
  const { system } = await systemPromptFor("how do I start?", rootWithSnapshots());
  assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: develop\)/);
});

test("an unsupported version is answered from the nearest release with an explicit caveat", async () => {
  const root = rootWithSnapshots();
  let system = "";
  const client = {
    messages: {
      create: async (...args: unknown[]): Promise<AnthropicLikeResponse> => {
        system = (args[0] as { system: { text: string }[] }).system.map((s) => s.text).join("\n");
        return { content: [{ type: "text", text: "The CLI lives in d2e/." }], stop_reason: "end_turn" };
      },
    },
  };
  const prev = process.env.KB_ROOT;
  process.env.KB_ROOT = root;
  try {
    const result = await answerQuestionRetrieval("v0.17 why does the CLI fail?", [], client);
    assert.match(system, /KNOWLEDGE BASE INDEX \(snapshot: v0\.18\.0-beta\)/);
    assert.match(result.text, /outside the supported range/);
    assert.match(result.text, /v0\.17/);
    assert.match(result.text, /The CLI lives in d2e/);
    assert.equal(result.covered, true);
  } finally {
    if (prev === undefined) delete process.env.KB_ROOT;
    else process.env.KB_ROOT = prev;
  }
});
