import { describe, expect, it } from "vitest";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "../src/index.js";

const tripInput: CreateTripInput = {
  title: "London to Berlin",
  cadenceHours: 6,
  brief: {
    originAirports: ["LHR"], destinationAirports: ["BER"], tripType: "one_way",
    departureWindow: { start: "2026-09-10", end: "2026-09-10" }, stayNights: null,
    travellers: { adults: 1, childrenAges: [], infants: 0 }, cabin: "economy",
    maxStops: 1, currency: "GBP", maximumPrice: null,
    preferredAirlines: [], excludedAirlines: [], context: ""
  }
};

async function user(store: MemoryCaptainPlatformStore, telegramUserId: number) {
  return store.ensureTelegramUser({
    telegramUserId, telegramChatId: telegramUserId, username: null,
    firstName: `User ${telegramUserId}`, lastName: null
  }, new Date("2026-08-01T12:00:00Z"));
}

describe("Captain platform store", () => {
  it("activates every new Telegram user", async () => {
    const store = new MemoryCaptainPlatformStore();
    await expect(user(store, 1)).resolves.toMatchObject({ status: "active", telegramUserId: 1 });
  });

  it("keeps Trips tenant-scoped", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const grace = await user(store, 2);
    const created = await store.createTrip(ada.id, tripInput, buildSearchSpecs(tripInput.brief, false), new Date("2026-08-01T12:00:00Z"));
    expect(await store.getTrip(ada.id, created.trip.id)).not.toBeNull();
    expect(await store.getTrip(grace.id, created.trip.id)).toBeNull();
    expect(await store.listTrips(grace.id)).toEqual([]);
  });

  it("reuses an exact active Trip instead of creating a duplicate", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const specs = buildSearchSpecs(tripInput.brief, false);
    const first = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    const retried = await store.createTrip(ada.id, { ...tripInput, title: "Same journey" }, specs, new Date("2026-08-01T12:00:01Z"));
    expect(retried.trip.id).toBe(first.trip.id);
    expect(await store.listTrips(ada.id)).toHaveLength(1);
  });

  it("deduplicates one shared search across two users", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const grace = await user(store, 2);
    const specs = buildSearchSpecs(tripInput.brief, false);
    await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.createTrip(grace.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100)).toBe(1);
    const claimed = await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 4);
    expect(claimed).toHaveLength(1);
  });

  it("fans one result out into initial recommendations and notifications", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const specs = buildSearchSpecs(tripInput.brief, false);
    await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
    const run = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", run.id, "orq_1", [{
      itineraryKey: "BA982|LHR|BER", provider: "duffel", providerOfferId: "off_1",
      providerSearchId: "orq_1", price: 100, currency: "GBP",
      expiresAt: "2026-08-01T12:30:00Z", observedAt: "2026-08-01T12:00:01Z",
      snapshot: { route: "LHR → BER", airlineCodes: ["BA"], stops: 0, durationSeconds: 7_200, segments: [] }
    }], new Date("2026-08-01T12:00:01Z"));
    expect(await store.evaluateTripsForSearchSpec(run.searchSpecId, new Date("2026-08-01T12:00:02Z"))).toBe(1);
    const notifications = await store.listPendingNotifications(new Date("2026-08-01T12:00:03Z"), 10);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "initial_results", telegramChatId: 1 });
  });

  it("recovers an expired lease without duplicating a live claim", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const specs = buildSearchSpecs(tripInput.brief, false);
    await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
    expect(await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1)).toHaveLength(1);
    expect(await store.claimSearchRuns("worker-2", new Date("2026-08-01T12:01:00Z"), 180_000, 1)).toHaveLength(0);
    expect(await store.claimSearchRuns("worker-2", new Date("2026-08-01T12:04:00Z"), 180_000, 1)).toHaveLength(1);
  });

  it("reuses fresh shared results for a newly attached Trip", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const grace = await user(store, 2);
    const specs = buildSearchSpecs(tripInput.brief, false);
    await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
    const run = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", run.id, "orq_1", [{
      itineraryKey: "BA982|LHR|BER", provider: "duffel", providerOfferId: "off_1",
      providerSearchId: "orq_1", price: 100, currency: "GBP",
      expiresAt: "2026-08-01T12:30:00Z", observedAt: "2026-08-01T12:00:01Z",
      snapshot: { route: "LHR → BER", airlineCodes: ["BA"], stops: 0, durationSeconds: 7_200, segments: [] }
    }], new Date("2026-08-01T12:00:01Z"));
    await store.evaluateTripsForSearchSpec(run.searchSpecId, new Date("2026-08-01T12:00:02Z"));
    const created = await store.createTrip(grace.id, tripInput, specs, new Date("2026-08-01T12:05:00Z"));
    expect(created.trip.status).toBe("recommended");
    expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:05:00Z"), 900_000, 100)).toBe(0);
    const notifications = await store.listPendingNotifications(new Date("2026-08-01T12:05:01Z"), 10);
    expect(notifications.some((notification) => notification.userId === grace.id)).toBe(true);
  });
});
