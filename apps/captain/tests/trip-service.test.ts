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
        expect.objectContaining({ eventType: "trip_plan_changed" }),
        expect.objectContaining({ eventType: "trip_created" })
      ])
    );
  });

  it("renames a draft without confirming it, then atomically starts tracking", async () => {
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
      title: "LOS → NBO",
      brief: defaultTestBrief({ destinationAirports: ["NBO"] })
    });
    const renamed = await service.rename(owner.id, created.trip.id, {
      expectedVersion: created.trip.version,
      title: "Nairobi wedding"
    });
    await store.updateProfile(owner.id, { notificationMode: "off" }, now);
    expect(renamed).toMatchObject({ title: "Nairobi wedding", status: "draft", version: 2 });
    expect(await store.getWatch(owner.id, created.trip.id)).toBeNull();

    const confirmed = await service.action(owner.id, created.trip.id, {
      type: "track",
      expectedVersion: renamed.version
    });
    expect(confirmed).toMatchObject({ status: "tracking", version: 3 });
    expect(await store.getWatch(owner.id, created.trip.id)).toMatchObject({
      status: "active",
      checksCompleted: 0,
      nextCheckAt: now.toISOString()
    });
    await expect(store.listPendingNotifications(now, 10)).resolves.toEqual([
      expect.objectContaining({
        tripId: created.trip.id,
        kind: "tracking_started",
        payload: expect.objectContaining({
          eventType: "trip_tracking_started",
          tripVersion: 3
        })
      })
    ]);
    await service.action(owner.id, created.trip.id, {
      type: "track",
      expectedVersion: confirmed.version
    });
    await expect(store.listPendingNotifications(now, 10)).resolves.toHaveLength(1);
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

  it("lets a conversational channel own the action acknowledgement", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 3,
      telegramChatId: 3,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → LHR",
      brief: defaultTestBrief()
    });

    await service.action(owner.id, created.trip.id, {
      type: "cancel",
      expectedVersion: created.trip.version
    }, { notifyCheckpoint: false });

    expect(await store.listPendingNotifications(now, 10)).toEqual([]);
    expect(await store.listTripActivity(owner.id, created.trip.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: "trip_cancel" })])
    );
  });

  it("keeps replacement as a quiet checkpoint beside the new-plan reply", async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 4,
      telegramChatId: 4,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → LHR",
      brief: defaultTestBrief()
    });

    await store.archiveTripForReplacement(owner.id, created.trip.id, now);

    expect(await store.listPendingNotifications(now, 10)).toEqual([]);
    expect(await store.listTripActivity(owner.id, created.trip.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: "trip_replaced" })])
    );
  });
});
