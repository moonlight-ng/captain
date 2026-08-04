import { createHmac, timingSafeEqual } from "node:crypto";

export type CaptainWebPath = "/trip" | "/profile" | "/preferences" | "/settings";
/** Paths that may be targeted by single-use login tokens / session cookies. */
export type CaptainSessionPath = "/trip" | "/profile" | "/preferences" | "/settings" | "/payment" | "/travellers";

const TOKEN_VERSION = "v1";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createCaptainAccessToken(userId: string, secret: string): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("Invalid Captain user ID");
  if (!secret.trim()) throw new Error("Captain link secret is required");
  const subject = Buffer.from(userId, "utf8").toString("base64url");
  const payload = `${TOKEN_VERSION}.${subject}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function resolveCaptainAccessToken(token: string, secret: string): string | null {
  const [version, subject, provided, ...rest] = token.split(".");
  if (version !== TOKEN_VERSION || !subject || !provided || rest.length > 0 || !secret.trim()) {
    return null;
  }
  const expected = signature(`${version}.${subject}`, secret);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(providedBuffer, expectedBuffer)
  ) return null;
  try {
    const userId = Buffer.from(subject, "base64url").toString("utf8");
    return USER_ID_PATTERN.test(userId) ? userId : null;
  } catch {
    return null;
  }
}

export function createCaptainAccessLink(
  publicUrl: string,
  path: CaptainWebPath,
  userId: string,
  secret: string
): string {
  const url = new URL(path, `${publicUrl.replace(/\/$/u, "")}/`);
  url.hash = new URLSearchParams({
    access: createCaptainAccessToken(userId, secret)
  }).toString();
  return url.toString();
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`captain-design-access:${payload}`)
    .digest("base64url");
}
