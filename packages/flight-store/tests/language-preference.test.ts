import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "../src/memory-store.js";

describe("language preference storage", () => {
  it("starts in eligible default English and atomically claims detection once", async () => {
    const store = new MemoryCaptainPlatformStore();
    const now = new Date("2026-08-15T10:00:00.000Z");
    const user = await store.ensureTelegramUser({
      telegramUserId: 1,
      telegramChatId: 1,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    await expect(store.ensureProfile(user.id, now)).resolves.toMatchObject({
      preferredLanguage: "en",
      preferredLanguageSource: "default",
      preferredLanguageSetAt: null
    });
    await expect(store.claimDetectedLanguage(user.id, "fr", now)).resolves.toMatchObject({
      claimed: true,
      profile: { preferredLanguage: "fr", preferredLanguageSource: "detected" }
    });
    await expect(store.claimDetectedLanguage(user.id, "es", now)).resolves.toMatchObject({
      claimed: false,
      profile: { preferredLanguage: "fr", preferredLanguageSource: "detected" }
    });
  });

  it("supports explicit changes and automatic reset", async () => {
    const store = new MemoryCaptainPlatformStore();
    const now = new Date("2026-08-15T10:00:00.000Z");
    const user = await store.ensureTelegramUser({
      telegramUserId: 2,
      telegramChatId: 2,
      username: null,
      firstName: "Mina",
      lastName: null
    }, now);
    await expect(store.updateProfile(user.id, { preferredLanguage: "fr" }, now))
      .resolves.toMatchObject({ preferredLanguage: "fr", preferredLanguageSource: "user" });
    await expect(store.updateProfile(user.id, { preferredLanguage: null }, now))
      .resolves.toMatchObject({
        preferredLanguage: "en",
        preferredLanguageSource: "default",
        preferredLanguageSetAt: null
      });
  });

  it("allows only one concurrent detection claim", async () => {
    const store = new MemoryCaptainPlatformStore();
    const now = new Date("2026-08-15T10:00:00.000Z");
    const user = await store.ensureTelegramUser({
      telegramUserId: 3,
      telegramChatId: 3,
      username: null,
      firstName: "Tola",
      lastName: null
    }, now);
    const results = await Promise.all([
      store.claimDetectedLanguage(user.id, "fr", now),
      store.claimDetectedLanguage(user.id, "es", now)
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    await expect(store.ensureProfile(user.id, now)).resolves.toMatchObject({
      preferredLanguageSource: "detected",
      preferredLanguage: results.find((result) => result.claimed)!.profile.preferredLanguage
    });
  });
});
