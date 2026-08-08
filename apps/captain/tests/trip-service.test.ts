import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { TripLimitError, TripNotFoundError } from "@agents/flight-domain";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

describe("Trip service", () => {
  it("creates, updates, and pauses only the owning traveller's Trip", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({ telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null }, now);
    const other = await store.ensureTelegramUser({ telegramUserId: 2, telegramChatId: 2, username: null, firstName: "Grace", lastName: null }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, { title: "New York", brief: defaultTestBrief() });
    expect(created.created).toBe(true);
    expect(created.searchCombinations).toBe(0);
    expect(created.watch).toBeNull();
    const duplicate = await service.create(owner.id, { title: "New York", brief: defaultTestBrief() });
    expect(duplicate.created).toBe(false);
    expect(duplicate.trip.id).toBe(created.trip.id);
    expect(await service.get(other.id, created.trip.id)).toBeNull();
    await expect(service.action(other.id, created.trip.id, { type: "pause", expectedVersion: 1 })).rejects.toBeInstanceOf(TripNotFoundError);
    const paused = await service.action(owner.id, created.trip.id, { type: "pause", expectedVersion: 1 });
    expect(paused).toMatchObject({ status: "paused", version: 2 });
  });

  it("allows consecutive manual refreshes", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 1,
      telegramChatId: 1,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "New York",
      brief: defaultTestBrief()
    });
    const refreshed = await service.action(owner.id, created.trip.id, {
      type: "refresh",
      expectedVersion: 1
    });
    await expect(service.action(owner.id, created.trip.id, {
      type: "refresh",
      expectedVersion: refreshed.version
    })).resolves.toMatchObject({ status: "draft" });
  });

  it("updates one Trip brief without scheduling a search and records the change", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 1,
      telegramChatId: 1,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "New York",
      brief: defaultTestBrief()
    });
    const updated = await service.update(owner.id, created.trip.id, {
      expectedVersion: created.trip.version,
      brief: defaultTestBrief({
        destinationAirports: ["CDG"],
        currency: "EUR",
        maximumPrice: 850,
        context: "Arrive before dinner"
      })
    });

    expect(updated).toMatchObject({
      id: created.trip.id,
      status: "draft",
      version: created.trip.version + 1,
      brief: {
        destinationAirports: ["CDG"],
        currency: "EUR",
        maximumPrice: 850
      }
    });
    await expect(store.getWatch(owner.id, created.trip.id)).resolves.toBeNull();
    await expect(store.listTripActivity(owner.id, created.trip.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "trip_brief_updated" }),
        expect.objectContaining({ eventType: "trip_created" })
      ])
    );
  });

  it("saves one active Trip without replacement and rejects a second", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 1,
      telegramChatId: 1,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    await service.create(owner.id, {
      title: "Anambra",
      brief: defaultTestBrief({ destinationAirports: ["ANA"] })
    });
    expect((await service.list(owner.id)).filter((trip) => trip.status === "draft"))
      .toHaveLength(1);
    await expect(service.create(owner.id, {
      title: "Nairobi",
      brief: defaultTestBrief({ destinationAirports: ["NBO"] })
    })).rejects.toBeInstanceOf(TripLimitError);
    const tracked = (await service.list(owner.id)).filter((trip) => trip.status === "draft");
    await service.action(owner.id, tracked[0]!.id, {
      type: "cancel",
      expectedVersion: tracked[0]!.version
    });
    await expect(service.create(owner.id, {
      title: "Nairobi",
      brief: defaultTestBrief({ destinationAirports: ["NBO"] })
    })).resolves.toMatchObject({ created: true });
  });
});
