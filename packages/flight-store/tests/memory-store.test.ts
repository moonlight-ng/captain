import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => vi.unstubAllEnvs());

  it("activates every new Telegram user", async () => {
    const store = new MemoryCaptainPlatformStore();
    await expect(user(store, 1)).resolves.toMatchObject({ status: "active", telegramUserId: 1 });
  });

  it("gates every new profile behind the onboarding welcome", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    await expect(
      store.ensureProfile(ada.id, new Date("2026-08-01T12:00:00Z"))
    ).resolves.toMatchObject({
      onboardingStep: "welcome",
      onboardingCompletedAt: null
    });
  });

  it("stores the traveller timezone used by conversational date resolution", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    await expect(store.updateUserTimezone(
      ada.id,
      "Africa/Lagos",
      new Date("2026-08-01T12:00:00Z")
    )).resolves.toMatchObject({ timezone: "Africa/Lagos" });
    await expect(store.getUser(ada.id)).resolves.toMatchObject({
      timezone: "Africa/Lagos"
    });
  });

  it("enforces the configured public beta capacity", async () => {
    vi.stubEnv("CAPTAIN_BETA_USER_LIMIT", "1");
    const store = new MemoryCaptainPlatformStore();
    await user(store, 1);
    await expect(user(store, 2)).rejects.toMatchObject({
      name: "BetaCapacityError",
      limit: 1
    });
  });

  it("keeps new travellers out until the launch gate is explicitly opened", async () => {
    const store = new MemoryCaptainPlatformStore();
    const existing = await user(store, 1);
    vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", "false");

    await expect(user(store, 1)).resolves.toMatchObject({ id: existing.id });
    await expect(user(store, 2)).rejects.toMatchObject({
      name: "BetaLaunchGateError"
    });
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
      itineraryKey: "BA982|LHR|BER", provider: "openai_web", providerOfferId: "off_1",
      providerSearchId: "orq_1", price: 100, currency: "GBP",
      ...verifiedMetadata("100.00", "BA"),
      expiresAt: "2026-08-01T12:30:00Z", observedAt: "2026-08-01T12:00:01Z",
      snapshot: { route: "LHR → BER", airlineCodes: ["BA"], stops: 0, durationSeconds: 7_200, segments: [] }
    }], new Date("2026-08-01T12:00:01Z"));
    expect(await store.evaluateTripsForSearchSpec(run.searchSpecId, new Date("2026-08-01T12:00:02Z"))).toBe(1);
    const trip = (await store.listTrips(ada.id))[0]!;
    const [offer] = await store.listTripOffers(ada.id, trip.id, new Date("2026-08-01T12:00:03Z"));
    await store.setTripFlightSelection(
      ada.id,
      trip.id,
      offer!.itineraryKey,
      true,
      new Date("2026-08-01T12:00:04Z")
    );
    expect(await store.listTripFlightSelections(ada.id, trip.id)).toEqual([
      expect.objectContaining({
        itineraryKey: offer!.itineraryKey,
        selectedBy: "agent"
      }),
      expect.objectContaining({
        itineraryKey: offer!.itineraryKey,
        selectedBy: "person"
      })
    ]);
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
      itineraryKey: "BA982|LHR|BER", provider: "openai_web", providerOfferId: "off_1",
      providerSearchId: "orq_1", price: 100, currency: "GBP",
      ...verifiedMetadata("100.00", "BA"),
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
      cadenceHours: 3,
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

    expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100)).toBe(1);
    expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
      nextCheckAt: "2026-08-02T00:00:00.000Z"
    });
  });

  it("replaces current results, keeps every compact offer, and preserves price-drop context", async () => {
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
        provider: "openai_web" as const,
        providerOfferId: `old_${index}`,
        providerSearchId: "orq_1",
        price: 200 + index,
        currency: "GBP",
        ...verifiedMetadata(`${200 + index}.00`, "BA"),
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
    expect(firstOffers).toHaveLength(40);
    expect(firstOffers.every((offer) => !("raw" in offer.snapshot))).toBe(true);

    await store.scheduleDueSearchRuns(new Date("2026-08-02T00:00:00Z"), 900_000, 100);
    const secondRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-02T00:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", secondRun.id, "orq_2", Array.from({ length: 3 }, (_, index) => ({
      itineraryKey: `BA${100 + index}|LHR|BER`,
      provider: "openai_web" as const,
      providerOfferId: `new_${index}`,
      providerSearchId: "orq_2",
      price: 100 + index,
      currency: "GBP",
      ...verifiedMetadata(`${100 + index}.00`, "BA"),
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

  it("keeps previous offers when a later search returns no verified fares", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const specs = buildSearchSpecs(tripInput.brief, false);
    const created = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
    await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
    const firstRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", firstRun.id, "orq_1", [{
      itineraryKey: "BA982|LHR|BER",
      provider: "openai_web",
      providerOfferId: "offer_1",
      providerSearchId: "orq_1",
      price: 199,
      currency: "GBP",
      ...verifiedMetadata("199.00", "BA"),
      expiresAt: "2026-08-02T12:30:00Z",
      observedAt: "2026-08-01T12:00:01Z",
      snapshot: {
        route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: ["BA982"],
        stops: 0, durationSeconds: 7_200, segments: []
      }
    }], new Date("2026-08-01T12:00:01Z"));
    expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-01T12:00:02Z"))).toHaveLength(1);

    await store.scheduleDueSearchRuns(new Date("2026-08-02T00:00:00Z"), 900_000, 100);
    const emptyRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-02T00:00:00Z"), 180_000, 1))[0]!;
    await store.completeSearchRun("worker-1", emptyRun.id, "orq_empty", [], new Date("2026-08-02T00:00:01Z"));

    expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-02T00:00:02Z"))).toHaveLength(1);
    expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
      delayReason: "No verified fares this check; keeping last results."
    });
  });

  it("caps improvement alerts at two in a rolling 24 hours", async () => {
    const store = new MemoryCaptainPlatformStore();
    const ada = await user(store, 1);
    const input: CreateTripInput = {
      ...tripInput,
      cadenceHours: 3,
      brief: {
        ...tripInput.brief,
        tripType: "one_way",
        departureWindow: { start: "2026-08-05", end: "2026-08-05" },
        stayNights: null
      }
    };
    const specs = buildSearchSpecs(input.brief, false);
    await store.createTrip(ada.id, input, specs, new Date("2026-08-01T12:00:00Z"));
    const changes: number[] = [];

    for (const [index, price] of [100, 90, 80, 70].entries()) {
      const now = new Date(Date.parse("2026-08-01T12:00:00Z") + index * 3 * 3_600_000);
      await store.scheduleDueSearchRuns(now, 900_000, 100);
      const run = (await store.claimSearchRuns("worker-1", now, 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", run.id, `orq_${index}`, [{
        itineraryKey: "BA982|LHR|BER",
        provider: "openai_web",
        providerOfferId: `offer_${index}`,
        providerSearchId: `orq_${index}`,
        price,
        currency: "GBP",
        ...verifiedMetadata(`${price}.00`, "BA"),
        expiresAt: null,
        observedAt: now.toISOString(),
        snapshot: {
          route: "LHR → BER",
          airlineCodes: ["BA"],
          flightNumbers: ["BA982"],
          stops: 0,
          durationSeconds: 7_200,
          segments: []
        }
      }], now);
      changes.push(await store.evaluateTripsForSearchSpec(run.searchSpecId, now));
    }

    expect(changes).toEqual([1, 1, 1, 0]);
    expect(await store.listPendingNotifications(
      new Date("2026-08-01T22:00:00Z"),
      10
    )).toHaveLength(3);
  });
});

function verifiedMetadata(priceAmount: string, airlineCode: string) {
  return {
    priceAmount,
    fareBasis: "one_adult_total" as const,
    primaryAirlineCode: airlineCode,
    participatingAirlineCodes: [airlineCode],
    evidence: [{ url: "https://ba.com/flight", title: "Verified fare", domain: "ba.com" }],
    discoveryResponseId: "resp_discovery",
    verificationResponseId: "resp_verification",
    promptVersion: "test-v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:01Z"
  };
}
