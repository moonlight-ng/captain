import { describe, expect, it } from "vitest";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "../src/index.js";

const tripInput: CreateTripInput = {
  title: "London to Berlin",
  cadenceHours: 6,
  brief: {
    originAirports: ["LHR"], destinationAirports: ["BER"], tripType: "one_way",
    departureWindow: { start: "2026-09-10", end: "2026-09-10" }, stayNights: null,
    legs: [],
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

  it("does not return history when a caller requests structured state only", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    await store.appendMessage(ada.id, "user", "Plan a Trip", new Date("2026-08-01T12:00:00Z"));

    await expect(store.getConversation(ada.id, 0)).resolves.toMatchObject({
      recentMessages: []
    });
  });

  it("permits only one concurrently-created open Trip draft per traveller", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const [first, second] = await Promise.all([
      store.createTripPlanDraft(ada.id, "Plan Lagos to New York", null, new Date("2026-08-01T12:00:00Z")),
      store.createTripPlanDraft(ada.id, "Plan Lagos to London", null, new Date("2026-08-01T12:00:00Z"))
    ]);

    expect(second.id).toBe(first.id);
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

  it("schedules a bounded discovery batch and slows a distant watch", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const input: CreateTripInput = {
      ...tripInput,
      cadenceHours: 1,
      brief: {
        ...tripInput.brief,
        departureWindow: { start: "2026-09-10", end: "2026-09-19" }
      }
    };
    const created = await store.createTrip(
      ada.id,
      input,
      buildSearchSpecs(input.brief, false),
      new Date("2026-08-01T12:00:00Z")
    );

    expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100)).toBe(6);
    expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
      nextCheckAt: "2026-08-02T00:00:00.000Z"
    });
  });

  it("replaces current results, keeps only 25 compact offers, and preserves price-drop context", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const specs = buildSearchSpecs(tripInput.brief, false);
    const created = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
    const firstRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun(
      "worker-1",
      firstRun.id,
      "orq_1",
      Array.from({ length: 40 }, (_, index) => ({
        itineraryKey: `BA${100 + index}|LHR|BER`,
        provider: "duffel" as const,
        providerOfferId: `old_${index}`,
        providerSearchId: "orq_1",
        price: 200 + index,
        currency: "GBP",
        expiresAt: "2026-08-02T12:30:00Z",
        observedAt: "2026-08-01T12:00:01Z",
        snapshot: {
          route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: [`BA${100 + index}`],
          stops: 0, durationSeconds: 7_200, segments: [], raw: { oversized: "x".repeat(10_000) }
        }
      })),
      new Date("2026-08-01T12:00:01Z")
    );
    expect(await store.evaluateTripsForSearchSpec(firstRun.searchSpecId, new Date("2026-08-01T12:00:02Z"))).toBe(1);
    const firstOffers = await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-01T12:00:03Z"));
    expect(firstOffers).toHaveLength(25);
    expect(firstOffers.every((offer) => !("raw" in offer.snapshot))).toBe(true);

    await store.scheduleDueSearchRuns(new Date("2026-08-02T00:00:00Z"), 900_000, 100);
    const secondRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-02T00:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", secondRun.id, "orq_2", Array.from({ length: 3 }, (_, index) => ({
      itineraryKey: `BA${100 + index}|LHR|BER`,
      provider: "duffel" as const,
      providerOfferId: `new_${index}`,
      providerSearchId: "orq_2",
      price: 100 + index,
      currency: "GBP",
      expiresAt: "2026-08-02T12:30:00Z",
      observedAt: "2026-08-02T00:00:01Z",
      snapshot: {
        route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: [`BA${100 + index}`],
        stops: 0, durationSeconds: 7_200, segments: []
      }
    })), new Date("2026-08-02T00:00:01Z"));

    expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-02T00:00:02Z"))).toHaveLength(3);
    expect(await store.evaluateTripsForSearchSpec(secondRun.searchSpecId, new Date("2026-08-02T00:00:03Z"))).toBe(1);
    expect(await store.listPendingNotifications(new Date("2026-08-02T08:00:00Z"), 10)).toHaveLength(2);
  });
});
