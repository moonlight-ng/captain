import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { TripNotFoundError } from "@agents/flight-domain";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

describe("Trip service", () => {
  it("creates, updates, and pauses only the owning traveller's Trip", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({ telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null }, now);
    const other = await store.ensureTelegramUser({ telegramUserId: 2, telegramChatId: 2, username: null, firstName: "Grace", lastName: null }, now);
    const service = new TripService({ store, liveMode: false, now: () => now });
    const created = await service.create(owner.id, { title: "New York", brief: defaultTestBrief(), cadenceHours: 6 });
    expect(created.searchCombinations).toBe(3);
    expect(await service.get(other.id, created.trip.id)).toBeNull();
    await expect(service.action(other.id, created.trip.id, { type: "pause", expectedVersion: 1 })).rejects.toBeInstanceOf(TripNotFoundError);
    const paused = await service.action(owner.id, created.trip.id, { type: "pause", expectedVersion: 1 });
    expect(paused).toMatchObject({ status: "paused", version: 2 });
  });
});
