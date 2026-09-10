import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  signingSecret: string,
): boolean {
  if (!signature || !timestamp) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const hmac = createHmac("sha256", signingSecret);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  const expected = `v0=${hmac.digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function adminIds(): Set<string> {
  return new Set(
    (process.env.KB_FEEDBACK_ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
}

export function isAdmin(userId?: string): boolean {
  return Boolean(userId) && adminIds().has(userId as string);
}

const BUSY_PATTERN = /\b(429|5\d\d)\b/;

export function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    if (BUSY_PATTERN.test(err.message)) {
      return "The AI service is busy right now — please try again in a moment";
    }
    return err.message;
  }
  return "Something went wrong — please try again.";
}
