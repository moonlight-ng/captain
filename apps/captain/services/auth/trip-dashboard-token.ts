import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const payloadSchema = z.object({
  userId: z.uuid(),
  tripId: z.uuid(),
  expiresAt: z.number().int(),
  nonce: z.string().min(16)
}).strict();

export type TripDashboardPrincipal = z.infer<typeof payloadSchema>;
export type CompactTripDashboardPrincipal = {
  tripId: string;
  expiresAt: number;
};

export function issueTripDashboardToken(options: {
  secret: string;
  userId: string;
  tripId: string;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}): string {
  const payload = Buffer.from(JSON.stringify({
    userId: options.userId,
    tripId: options.tripId,
    expiresAt: (options.now ?? Date.now()) + (options.ttlMs ?? 180 * 86_400_000),
    nonce: options.nonce ?? randomUUID()
  })).toString("base64url");
  return `${payload}.${signature(options.secret, payload)}`;
}

export function verifyTripDashboardToken(
  token: string,
  secret: string,
  now = Date.now()
): TripDashboardPrincipal | null {
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = signature(secret, payload);
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }
  try {
    const parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.expiresAt > now ? parsed : null;
  } catch {
    return null;
  }
}

export function issueCompactTripDashboardToken(options: {
  secret: string;
  tripId: string;
  now?: number;
  ttlMs?: number;
}): string {
  const tripId = z.uuid().parse(options.tripId);
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? 180 * 86_400_000);
  const payloadBytes = Buffer.alloc(20);
  Buffer.from(tripId.replaceAll("-", ""), "hex").copy(payloadBytes, 0);
  payloadBytes.writeUInt32BE(Math.floor(expiresAt / 1_000), 16);
  const payload = payloadBytes.toString("base64url");
  return `${payload}.${compactSignature(options.secret, payload)}`;
}

export function verifyCompactTripDashboardToken(
  token: string,
  secret: string,
  now = Date.now()
): CompactTripDashboardPrincipal | null {
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = compactSignature(secret, payload);
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length !== 20) return null;
    const expiresAt = bytes.readUInt32BE(16) * 1_000;
    if (expiresAt <= now) return null;
    const hex = bytes.subarray(0, 16).toString("hex");
    const tripId = z.uuid().parse(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    );
    return { tripId, expiresAt };
  } catch {
    return null;
  }
}

export function tripDashboardUrl(options: {
  publicUrl: string;
  secret: string;
  userId: string;
  tripId: string;
}): string {
  const token = issueCompactTripDashboardToken(options);
  return `${options.publicUrl.replace(/\/$/u, "")}/t#${token}`;
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function compactSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`trip-dashboard:${payload}`).digest().subarray(0, 16).toString("base64url");
}
