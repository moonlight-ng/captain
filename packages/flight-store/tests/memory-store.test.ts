import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "../src/index.js";
import { describeCaptainPlatformStore } from "./conformance.js";

// The Postgres implementation runs the same suite in apps/captain, which owns
// the schema and its migrations.
describeCaptainPlatformStore(
  "MemoryCaptainPlatformStore",
  async () => new MemoryCaptainPlatformStore()
);

describe("MemoryCaptainPlatformStore card deletion concurrency", () => {
  it("does not hand the same deletion row to two concurrent claimants", async () => {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 99,
      telegramChatId: 99,
      username: null,
      firstName: "Ada",
      lastName: null
    }, new Date("2026-08-01T12:00:00Z"));
    const now = new Date("2026-08-01T12:00:00Z");
    const intentId = randomUUID();
    await store.reservePaymentCardSetupIntent(user.id, intentId, now);
    const method = await store.finalizePaymentMethod(user.id, {
      setupIntentId: intentId,
      cardId: "tcd_concurrent",
      brand: "visa",
      last4: "2222",
      cardholderName: "Ada"
    }, now);
    await store.removePaymentMethod(user.id, method.id, now);

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimCardDeletions(`worker-${index}`, now, 60_000, 10)
      )
    );
    const ids = claims.flat().map((row) => row.id);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(1);
  });
});
