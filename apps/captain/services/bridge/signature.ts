import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const BRIDGE_MAX_SKEW_MS = 5 * 60_000;

export type BridgeSignature = {
  timestamp: string;
  signature: string;
};

export function signBridgeRequest(options: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp?: string;
}): BridgeSignature {
  const timestamp = options.timestamp ?? String(Date.now());
  const canonical = canonicalRequest(timestamp, options.method, options.path, options.body);
  return {
    timestamp,
    signature: createHmac("sha256", options.secret).update(canonical).digest("hex")
  };
}

export function verifyBridgeRequest(options: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now?: number;
}): boolean {
  if (!options.timestamp || !options.signature) return false;
  const timestamp = Number(options.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs((options.now ?? Date.now()) - timestamp) > BRIDGE_MAX_SKEW_MS) return false;
  const expected = signBridgeRequest({
    secret: options.secret,
    method: options.method,
    path: options.path,
    body: options.body,
    timestamp: options.timestamp
  }).signature;
  const actualBytes = Buffer.from(options.signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function requestHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class BridgeReplayGuard {
  readonly #seen = new Map<string, number>();

  isReplay(signature: string, timestamp: number, now = Date.now()): boolean {
    for (const [key, seenAt] of this.#seen) {
      if (now - seenAt > BRIDGE_MAX_SKEW_MS) this.#seen.delete(key);
    }
    if (this.#seen.has(signature)) return true;
    this.#seen.set(signature, Number.isFinite(timestamp) ? timestamp : now);
    return false;
  }
}

function canonicalRequest(timestamp: string, method: string, path: string, body: string): string {
  return [
    timestamp,
    method.toUpperCase(),
    path,
    requestHash(body)
  ].join("\n");
}
