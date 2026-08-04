import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { CaptainWebAuth } from "../services/auth/web-session.js";

describe("Captain web auth", () => {
  const userId = "11111111-1111-4111-8111-111111111111";

  async function setup() {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 1,
      telegramChatId: 1,
      username: null,
      firstName: "Ada",
      lastName: "Lovelace"
    }, new Date());
    const auth = new CaptainWebAuth({
      publicUrl: "https://captain.example",
      secret: "telegram-bot-secret",
      store
    });
    return { store, auth, userId: user.id };
  }

  it("keeps reusable design links for trip and settings", async () => {
    const { auth, userId: id } = await setup();
    const link = auth.createAccessLink(id, "/settings");
    expect(new URL(link).pathname).toBe("/settings");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("access")!;
    await expect(auth.resolve(new Request("https://captain.example/api/auth/session", {
      headers: { authorization: `Bearer ${token}` }
    }))).resolves.toEqual({ userId: id, credential: "legacy-bearer" });
    expect(auth.createAccessLink(id, "/settings")).toBe(link);
  });

  it("exchanges a login token for a session cookie and rejects reuse", async () => {
    const { auth, userId: id } = await setup();
    const link = await auth.createLoginLink(id, "/settings");
    const raw = new URL(link).searchParams.get("t")!;
    const first = await auth.exchangeLoginToken(raw);
    expect(first).toMatchObject({ userId: id, redirectPath: "/settings" });
    await expect(auth.exchangeLoginToken(raw)).resolves.toBeNull();

    const cookieRequest = new Request("https://captain.example/api/auth/session", {
      headers: { cookie: `captain_session=${first!.sessionRaw}` }
    });
    await expect(auth.resolve(cookieRequest)).resolves.toEqual({
      userId: id,
      credential: "session"
    });
  });

  it("rejects expired login tokens", async () => {
    const { auth, store, userId: id } = await setup();
    const link = await auth.createLoginLink(id, "/settings");
    const raw = new URL(link).searchParams.get("t")!;
    const past = new Date("2020-01-01T00:00:00Z");
    // Force-expire by consuming against a late clock relative to mint time is
    // covered by createLoginToken TTL; mint with an already-expired row:
    const { createHash, randomBytes } = await import("node:crypto");
    const expiredRaw = randomBytes(32).toString("base64url");
    await store.createLoginToken(
      id,
      createHash("sha256").update(expiredRaw).digest("hex"),
      "/settings",
      past,
      past
    );
    await expect(auth.exchangeLoginToken(expiredRaw, new Date())).resolves.toBeNull();
    void link;
    void raw;
  });

  it("prefers the session cookie over a legacy bearer token", async () => {
    const { auth, userId: id } = await setup();
    const other = await auth.createLoginLink(id, "/settings");
    const session = await auth.exchangeLoginToken(new URL(other).searchParams.get("t")!);
    const bearer = new URLSearchParams(
      new URL(auth.createAccessLink(id, "/trip")).hash.slice(1)
    ).get("access")!;
    // Sign out then mint a different session — cookie should win when both present.
    const request = new Request("https://captain.example/api/auth/session", {
      headers: {
        cookie: `captain_session=${session!.sessionRaw}`,
        authorization: `Bearer ${bearer}`
      }
    });
    await expect(auth.resolve(request)).resolves.toEqual({
      userId: id,
      credential: "session"
    });
  });

  it("invalidates sessions on sign-out while legacy bearer still resolves", async () => {
    const { auth, userId: id } = await setup();
    const link = await auth.createLoginLink(id, "/settings");
    const session = await auth.exchangeLoginToken(new URL(link).searchParams.get("t")!);
    await auth.signOut(id);
    await expect(auth.resolve(new Request("https://captain.example/api/auth/session", {
      headers: { cookie: `captain_session=${session!.sessionRaw}` }
    }))).resolves.toBeNull();

    const bearer = new URLSearchParams(
      new URL(auth.createAccessLink(id, "/trip")).hash.slice(1)
    ).get("access")!;
    await expect(auth.resolve(new Request("https://captain.example/api/auth/session", {
      headers: { authorization: `Bearer ${bearer}` }
    }))).resolves.toEqual({ userId: id, credential: "legacy-bearer" });
  });

  it("builds a Secure session cookie for https public URLs", async () => {
    const { auth } = await setup();
    expect(auth.sessionCookieHeader("raw-token")).toContain("Secure");
    expect(auth.sessionCookieHeader("raw-token")).toContain("HttpOnly");
    expect(auth.sessionCookieHeader("raw-token")).toContain("SameSite=Lax");
  });
});
