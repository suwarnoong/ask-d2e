import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySlackSignature, isAdmin, friendlyError } from "../src/shared/slackAuth.js";
import { openDm, postMessage } from "./_lib/slackApi.js";
import { questionFor } from "../src/admin/wizard/steps.js";
import { encodeState } from "../src/admin/wizard/state.js";
import { prefillFromEntry } from "../src/admin/wizard/addRepoWizard.js";
import { withRegistryRetry, loadRegistry } from "../src/kb/registry.js";
import { readRawBody } from "./_lib/rawBody.js";

export const config = { api: { bodyParser: false } };

export type ParsedCommand =
  | { kind: "add-repo"; sourceRepo: string }
  | { kind: "set-cadence"; name: string; cadence: "daily" | "weekly" }
  | { kind: "edit-repo"; name: string }
  | { kind: "unrecognized"; raw: string };

const USAGE_HELP = [
  "Available:",
  "• /ask-admin add-repo owner/name — onboard a new repo",
  "• /ask-admin set-cadence <name> daily|weekly — change how often a repo refreshes",
  "• /ask-admin edit-repo <name> — revise a repo's audience/focus areas",
].join("\n");

export function parseAdminCommand(text: string): ParsedCommand {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const [sub, ...rest] = parts;

  if (sub === "add-repo" && rest.length === 1 && rest[0].includes("/")) {
    return { kind: "add-repo", sourceRepo: rest[0] };
  }
  if (sub === "set-cadence" && rest.length === 2 && (rest[1] === "daily" || rest[1] === "weekly")) {
    return { kind: "set-cadence", name: rest[0], cadence: rest[1] };
  }
  if (sub === "edit-repo" && rest.length === 1) {
    return { kind: "edit-repo", name: rest[0] };
  }
  return { kind: "unrecognized", raw: text };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawBody = await readRawBody(req);
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const ok = verifySlackSignature(
    rawBody,
    (req.headers["x-slack-signature"] as string) ?? null,
    (req.headers["x-slack-request-timestamp"] as string) ?? null,
    signingSecret,
  );
  if (!ok) {
    res.status(401).send("invalid signature");
    return;
  }

  const params = new URLSearchParams(rawBody);
  const userId = params.get("user_id") ?? "";
  const text = params.get("text") ?? "";
  const botToken = process.env.SLACK_BOT_TOKEN!;

  if (!isAdmin(userId)) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Admin actions are limited to the ask-d2e admin team — ping one of them if you need a repo added or removed.",
    });
    return;
  }

  const command = parseAdminCommand(text);
  try {
    if (command.kind === "unrecognized") {
      res.status(200).json({ response_type: "ephemeral", text: USAGE_HELP });
      return;
    }

    if (command.kind === "set-cadence") {
      const registry = loadRegistry(process.env.KB_ROOT ?? "./kb");
      if (!registry.some((e) => e.name === command.name)) {
        res.status(200).json({ response_type: "ephemeral", text: `No configured repo named \`${command.name}\`.` });
        return;
      }
      await withRegistryRetry(
        process.env.KB_ROOT ?? "./kb",
        process.env.KB_TARGET_BRANCH ?? "main",
        (entries) => entries.map((e) => (e.name === command.name ? { ...e, cadence: command.cadence } : e)),
        `chore(kb): set-cadence ${command.name} -> ${command.cadence}`,
      );
      res.status(200).json({ response_type: "ephemeral", text: `\`${command.name}\` now refreshes \`${command.cadence}\`.` });
      return;
    }

    const channel = await openDm(botToken, userId);

    if (command.kind === "add-repo") {
      const state = { active: true, step: "audience", sourceRepo: command.sourceRepo, answers: {} };
      const intro = `Got it — let's onboard \`${command.sourceRepo}\`.\n\n${questionFor("audience", state)}`;
      await postMessage({ botToken, channel, text: encodeState(intro, state) });
    } else {
      const registry = loadRegistry(process.env.KB_ROOT ?? "./kb");
      const entry = registry.find((e) => e.name === command.name);
      if (!entry) {
        res.status(200).json({ response_type: "ephemeral", text: `No configured repo named \`${command.name}\`.` });
        return;
      }
      const state = {
        active: true,
        step: "audience",
        sourceRepo: entry.sourceRepo,
        answers: prefillFromEntry(entry),
        editingRepoName: entry.name,
      };
      const intro = `Revising \`${entry.name}\` (${entry.sourceRepo}). Current audience: "${entry.promptSpec.audience}".\n\n${questionFor("audience", state)}`;
      await postMessage({ botToken, channel, text: encodeState(intro, state) });
    }

    res.status(200).json({ response_type: "ephemeral", text: "Check your DMs — I've started the wizard there." });
  } catch (err) {
    res.status(200).json({ response_type: "ephemeral", text: friendlyError(err) });
  }
}
