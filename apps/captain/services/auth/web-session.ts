import { createHash, randomBytes } from "node:crypto";

import {
  createCaptainAccessLink,
  resolveCaptainAccessToken,
  type CaptainSessionPath,
  type CaptainWebPath
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { ResolvedAuth } from "./legacy-bearer.js";

const SESSION_COOKIE = "captain_session";
const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_MAX_AGE = 2_592_000;

export class CaptainWebAuth {
  readonly #publicUrl: string;
  readonly #secret: string;
  readonly #store: CaptainPlatformStore;

  constructor(options: {
    publicUrl: string;
    secret: string;
    store: CaptainPlatformStore;
  }) {
    this.#publicUrl = options.publicUrl.replace(/\/$/u, "");
    this.#secret = options.secret;
    this.#store = options.store;
  }

  /** Legacy deterministic `#access` links for the trip and read-only profile surfaces. */
  createAccessLink(userId: string, redirectPath: CaptainWebPath): string {
    return createCaptainAccessLink(this.#publicUrl, redirectPath, userId, this.#secret);
  }

  async createLoginLink(
    userId: string,
    path: CaptainSessionPath,
    query?: Record<string, string>
  ): Promise<string> {
    const raw = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.#store.createLoginToken(
      userId,
      sha256hex(raw),
      path,
      new Date(now.getTime() + LOGIN_TTL_MS),
      now
    );
    const url = new URL(`${this.#publicUrl}/auth/link`);
    url.searchParams.set("t", raw);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (key === "t") continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async exchangeLoginToken(
    raw: string,
    now = new Date()
  ): Promise<{ userId: string; redirectPath: CaptainSessionPath; sessionRaw: string } | null> {
    const record = await this.#store.consumeLoginToken(sha256hex(raw), now);
    if (!record) return null;
    const sessionRaw = randomBytes(32).toString("base64url");
    await this.#store.createWebSession(
      record.userId,
      sha256hex(sessionRaw),
      new Date(now.getTime() + SESSION_TTL_MS),
      now
    );
    return { userId: record.userId, redirectPath: record.redirectPath, sessionRaw };
  }

  async resolve(request: Request, now = new Date()): Promise<ResolvedAuth | null> {
    const cookieToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (cookieToken) {
      const userId = await this.#store.resolveWebSession(sha256hex(cookieToken), now);
      if (userId) return { userId, credential: "session" };
    }
    const authorization = request.headers.get("authorization");
    const bearer = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "")?.[1];
    const userId = bearer ? resolveCaptainAccessToken(bearer, this.#secret) : null;
    return userId ? { userId, credential: "legacy-bearer" } : null;
  }

  async signOut(userId: string, now = new Date()): Promise<void> {
    await this.#store.revokeUserSessions(userId, now);
  }

  sessionCookieHeader(sessionRaw: string): string {
    const secure = this.#publicUrl.startsWith("https://") ? "; Secure" : "";
    return `${SESSION_COOKIE}=${sessionRaw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${secure}`;
  }

  redirectAfterLogin(
    redirectPath: CaptainSessionPath,
    requestUrl: string
  ): string {
    const target = new URL(redirectPath, `${this.#publicUrl}/`);
    const source = new URL(requestUrl);
    for (const [key, value] of source.searchParams.entries()) {
      if (key === "t") continue;
      target.searchParams.set(key, value);
    }
    return target.toString();
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
