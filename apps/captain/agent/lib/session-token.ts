import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const payloadSchema = z.object({ userId: z.uuid(), expiresAt: z.number().int(), nonce: z.string().min(16) }).strict();

export function issueCaptainSessionToken(options: {
  secret: string;
  userId: string;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}): string {
  const payload = Buffer.from(JSON.stringify({
    userId: options.userId,
    expiresAt: (options.now ?? Date.now()) + (options.ttlMs ?? 15 * 60_000),
    nonce: options.nonce ?? crypto.randomUUID()
  })).toString("base64url");
  return `${payload}.${signature(options.secret, payload)}`;
}

export function verifyCaptainSessionToken(token: string, secret: string, now = Date.now()): string | null {
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = signature(secret, payload);
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.expiresAt > now ? parsed.userId : null;
  } catch {
    return null;
  }
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
