import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySlackSignature, isAdmin, adminIds, friendlyError } from "../src/shared/slackAuth.js";
import { postMessage, openDm } from "./_lib/slackApi.js";
import { resolveRepoFromCitation, classifyRepoForQuestion } from "../src/kb/repoResolution.js";
import { loadRegistry } from "../src/kb/registry.js";
import { buildCorrectDispatchPayload } from "./_lib/selfHeal.js";

export function routeInteraction(actionId: string, isAdminUser: boolean): "thanks" | "log-and-notify-admins" | "dispatch-fix" {
  if (actionId === "feedback_up") return "thanks";
  return isAdminUser ? "dispatch-fix" : "log-and-notify-admins";
}

async function dispatchCorrectFix(repoName: string, question: string, answer: string): Promise<void> {
  const payload = buildCorrectDispatchPayload("fix", repoName, question, answer, "");
  const res = await fetch(`https://api.github.com/repos/suwarnoong/ask-d2e/actions/workflows/kb-correct.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`workflow_dispatch failed: ${res.status}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawBody = typeof req.body === "string" ? req.body : new URLSearchParams(req.body as Record<string, string>).toString();
  const ok = verifySlackSignature(
    rawBody,
    (req.headers["x-slack-signature"] as string) ?? null,
    (req.headers["x-slack-request-timestamp"] as string) ?? null,
    process.env.SLACK_SIGNING_SECRET!,
  );
  if (!ok) {
    res.status(401).send("invalid signature");
    return;
  }

  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload") ?? "{}");
  if (payload.type !== "block_actions") {
    res.status(200).send("");
    return;
  }

  const action = payload.actions?.[0];
  const userId = payload.user?.id ?? "";
  const question = (action?.value as string) ?? "";
  const answerText = (payload.message?.blocks ?? [])
    .filter((b: { type: string }) => b.type === "section")
    .map((b: { text?: { text?: string } }) => b.text?.text ?? "")
    .join("\n");

  res.status(200).send("");

  const botToken = process.env.SLACK_BOT_TOKEN!;
  const route = routeInteraction(action?.action_id ?? "", isAdmin(userId));

  try {
    if (route === "thanks") return;

    if (route === "log-and-notify-admins") {
      console.log(`KB feedback (down) from ${userId}: ${question}`);
      await Promise.allSettled(
        [...adminIds()].map(async (adminId) => {
          const channel = await openDm(botToken, adminId);
          await postMessage({ botToken, channel, text: `Flagged as wrong by <@${userId}>: "${question}"\nAnswer: ${answerText}` });
        }),
      );
      return;
    }

    // route === "dispatch-fix"
    const registry = loadRegistry(process.env.KB_ROOT ?? "./kb");
    let repoName = resolveRepoFromCitation(answerText);
    if (!repoName) {
      repoName = await classifyRepoForQuestion(question, registry);
    }
    if (!repoName) {
      console.log(`Could not resolve a repo for flagged answer: "${question}"`);
      return;
    }
    await dispatchCorrectFix(repoName, question, answerText);
  } catch (err) {
    console.error(friendlyError(err));
  }
}
