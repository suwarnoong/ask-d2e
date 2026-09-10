import Anthropic from "@anthropic-ai/sdk";
import { decodeState, encodeState, type WizardState } from "./state.js";
import { applyAnswer, questionFor } from "./steps.js";
import type { PromptSpec, RegistryEntry } from "../../kb/registry.js";
import type { SlackHistoryMessage } from "../../../api/_lib/slackApi.js";
import type { AnthropicLikeClient } from "../../shared/anthropicLike.js";
import { taskModel } from "../../shared/config.js";

export function slugFromSourceRepo(sourceRepo: string): string {
  const repoPart = sourceRepo.includes("/") ? sourceRepo.split("/")[1] : sourceRepo;
  return repoPart.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildCraftingPrompt(answers: Record<string, string>): string {
  return `
Turn these freeform onboarding answers into a structured PromptSpec JSON object shaped as:
{ "audience": string, "exampleQuestions": string[], "focusAreas": string[], "scopeNotes": string }

Audience (raw): ${answers.audience ?? ""}
Example questions (raw): ${answers.exampleQuestions ?? ""}
Focus areas (raw): ${answers.focusAreas ?? ""}
Additional notes from a restatement (raw, may be empty): ${answers.additionalNotes ?? ""}

Split freeform lists into array entries. If the admin implied anything should be excluded, put it
in scopeNotes; otherwise scopeNotes can be an empty string. Respond with only the JSON object.
`.trim();
}

export async function craftPromptSpec(answers: Record<string, string>, client?: AnthropicLikeClient): Promise<PromptSpec> {
  const anthropic =
    client ??
    (new Anthropic({
      authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      maxRetries: Number(process.env.ANSWER_MAX_RETRIES ?? 5),
    }) as unknown as AnthropicLikeClient);
  const response = await anthropic.messages.create({
    model: taskModel("CRAFTING_MODEL", "claude-sonnet-4-5"),
    max_tokens: 512,
    messages: [{ role: "user", content: buildCraftingPrompt(answers) }],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

export function summaryText(sourceRepo: string, promptSpec: PromptSpec): string {
  return [
    `Here's what I'll build for \`${sourceRepo}\`:`,
    `- Audience: ${promptSpec.audience}`,
    `- Example questions: ${promptSpec.exampleQuestions.join("; ")}`,
    `- Focus areas: ${promptSpec.focusAreas.join("; ")}`,
    `- Scope notes: ${promptSpec.scopeNotes || "(none)"}`,
    ``,
    `Reply "yes" to confirm, or restate anything to revise it (or "cancel" to stop).`,
  ].join("\n");
}

const GITHUB_INPUT_CAP = 1024;

export function buildInitialBuildDispatchPayload(
  repoName: string,
  sourceRepo: string,
  promptSpec: PromptSpec,
  cadence: "daily" | "weekly",
  createdBy: string,
): { ref: string; inputs: Record<string, string> } {
  let spec = { ...promptSpec };
  let json = JSON.stringify(spec);
  while (json.length > GITHUB_INPUT_CAP && (spec.exampleQuestions.length > 0 || spec.focusAreas.length > 0)) {
    if (spec.exampleQuestions.length > 0) {
      spec = { ...spec, exampleQuestions: spec.exampleQuestions.slice(0, -1) };
    } else {
      spec = { ...spec, focusAreas: spec.focusAreas.slice(0, -1) };
    }
    json = JSON.stringify(spec);
  }
  return {
    ref: "main",
    inputs: {
      repo_name: repoName,
      source_repo: sourceRepo,
      prompt_spec_json: json,
      cadence,
      created_by: createdBy,
    },
  };
}

export function prefillFromEntry(entry: RegistryEntry): Record<string, string> {
  return {
    audience: entry.promptSpec.audience,
    exampleQuestions: entry.promptSpec.exampleQuestions.join(", "),
    focusAreas: entry.promptSpec.focusAreas.join(", "),
  };
}

function findLatestState(history: SlackHistoryMessage[]): WizardState | null {
  // Slack's conversations.history returns messages newest-first, so the latest bot
  // message is found by scanning forward from index 0, not backward from the end.
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg.bot_id) continue;
    return decodeState(msg.text);
  }
  return null;
}

export interface ApplyWizardTurnDeps {
  craft?: typeof craftPromptSpec;
}

export interface ApplyWizardTurnResult {
  reply: string;
  state: WizardState;
  dispatch: { ref: string; inputs: Record<string, string> } | null;
}

export async function applyWizardTurn(
  dmHistory: SlackHistoryMessage[],
  incomingText: string,
  userId: string,
  deps: ApplyWizardTurnDeps = {},
): Promise<ApplyWizardTurnResult | null> {
  const current = findLatestState(dmHistory);
  if (!current) return null;

  const craft = deps.craft ?? craftPromptSpec;
  const text = incomingText.trim();

  if (text.toLowerCase() === "cancel") {
    const next = { ...current, active: false };
    return { reply: encodeState("Cancelled — no changes made.", next), state: next, dispatch: null };
  }

  if (current.step === "confirmed") {
    if (text.toLowerCase() === "yes") {
      const promptSpec: PromptSpec = JSON.parse(current.answers.craftedSpecJson);
      const cadence: "daily" | "weekly" = current.answers.cadence === "daily" ? "daily" : "weekly";
      const repoName = current.editingRepoName ?? slugFromSourceRepo(current.sourceRepo);
      const dispatch = buildInitialBuildDispatchPayload(repoName, current.sourceRepo, promptSpec, cadence, userId);
      const done = { ...current, active: false };
      return {
        reply: encodeState(`On it — building the initial knowledge base for \`${current.sourceRepo}\`, I'll let you know when it's ready.`, done),
        state: done,
        dispatch,
      };
    }
    const notes = [current.answers.additionalNotes, text].filter(Boolean).join("; ");
    const updatedAnswers = { ...current.answers, additionalNotes: notes };
    const promptSpec = await craft(updatedAnswers);
    const withCraft = { ...current, answers: { ...updatedAnswers, craftedSpecJson: JSON.stringify(promptSpec) } };
    return { reply: encodeState(summaryText(current.sourceRepo, promptSpec), withCraft), state: withCraft, dispatch: null };
  }

  const next = applyAnswer(current, text);
  if (!next.active) {
    return { reply: encodeState("Cancelled — no changes made.", next), state: next, dispatch: null };
  }

  if (next.step === "crafting") {
    const promptSpec = await craft(next.answers);
    const confirmedState: WizardState = {
      ...next,
      step: "confirmed",
      answers: { ...next.answers, craftedSpecJson: JSON.stringify(promptSpec) },
    };
    return { reply: encodeState(summaryText(next.sourceRepo, promptSpec), confirmedState), state: confirmedState, dispatch: null };
  }

  const question = questionFor(next.step, next);
  return { reply: encodeState(question, next), state: next, dispatch: null };
}
