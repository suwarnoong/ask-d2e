import type { IncomingMessage } from "node:http";

/**
 * Reads the exact raw request body bytes. Required for Slack signature
 * verification, which HMACs the original bytes — reconstructing a body
 * string from an already-parsed req.body (JSON.stringify / URLSearchParams)
 * is not guaranteed byte-identical and silently breaks verification.
 * Callers must disable Vercel's automatic body parsing
 * (`export const config = { api: { bodyParser: false } }`) for this to see
 * the unparsed stream.
 */
export function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
