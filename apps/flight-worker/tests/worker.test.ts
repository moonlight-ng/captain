import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSearchSpecs,
  type CreateTripInput,
  type FlightSearchProvider
} from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { FlightWorker, notificationText } from "../src/worker.js";

describe("flight worker orchestration", () => {
  // A tick clamps its own clock forward to real time, so the date a test hands
  // it is only honoured while it is the later of the two. Delivery and digests
  // read that clamped clock, so an unpinned suite decides what is due from the
  // wall clock: it passed by day and failed between 22:00 and 07:00, when the
  // default quiet hours hold notifications back and `notified` comes out zero.
  // Pinning the system clock to the date the tests already inject makes the
  // clamp a no-op and leaves what they exercise unchanged.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses only the due-work gate while the worker is idle", async () => {
    const store = new MemoryCaptainPlatformStore();
    const prune = vi.spyOn(store, "pruneWatchData");
    const maintain = vi.spyOn(store, "maintainTracking");
    const schedule = vi.spyOn(store, "scheduleDueSearchRuns");
    const claim = vi.spyOn(store, "claimSearchRuns");
    const notifications = vi.spyOn(store, "listPendingNotifications");
    const worker = new FlightWorker({
      store,
      provider: {
        provider: "official_duffel",
        search: vi.fn()
      } as unknown as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      workerId: "worker-1",
      leaseMs: 240_000,
      freshnessMs: 900_000,
      claimLimit: 1
    });

    await expect(worker.tick(new Date("2026-08-01T12:00:00Z")))
      .resolves.toEqual({ scheduled: 0, processed: 0, notified: 0 });
    await expect(worker.tick(new Date("2026-08-01T12:01:00Z")))
      .resolves.toEqual({ scheduled: 0, processed: 0, notified: 0 });

    expect(worker.lastTickHadDueWork).toBe(false);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
  });

  it("does not schedule a newly created manual-search trip", async () => {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null
    }, new Date("2026-08-01T12:00:00Z"));
    // Provider completion uses the wall clock, so keep this delivery assertion
    // deterministic when the suite runs during the profile's default quiet hours.
    await store.updateProfile(user.id, {
      quietHoursEnabled: false
    }, new Date("2026-08-01T12:00:00Z"));
    const input: CreateTripInput = {
      title: "Berlin",
      brief: {
        originAirports: ["LHR"], destinationAirports: ["BER"], tripType: "one_way",
        departureWindow: { start: "2026-09-10", end: "2026-09-10" }, stayNights: null,
        legs: [],
        travellers: { adults: 1, childrenAges: [], infants: 0 }, cabin: "economy",
        maxStops: 1, currency: "GBP", maximumPrice: null,
        preferredAirlines: [], excludedAirlines: [], context: ""
      }
    };
    await store.createTrip(user.id, input, buildSearchSpecs(input.brief, false), new Date("2026-08-01T12:00:00Z"));
    const search = vi.fn(async () => ({
      provider: "flysoar_mcp" as const,
      requestId: "resp_discovery:resp_verify",
      discoveryResponseId: "resp_discovery",
      verificationResponseId: "resp_verify",
      model: "gpt-5.6-sol",
      promptVersion: "test-v1",
      rejectionCounts: {},
      offers: [{
        itineraryKey: "verified-itinerary-1",
        priceAmount: "99.00",
        currency: "GBP",
        fareBasis: "one_adult_total" as const,
        cabin: "economy" as const,
        slices: [{
          origin: "LHR",
          destination: "BER",
          departureDate: "2026-09-10",
          segments: [{
            marketingAirlineCode: "BA",
            marketingAirline: "British Airways",
            flightNumber: "BA982",
            origin: "LHR",
            destination: "BER",
            departure: "2026-09-10T09:00:00+00:00",
            arrival: "2026-09-10T11:00:00+00:00"
          }]
        }],
        primaryAirlineCode: "BA",
        participatingAirlineCodes: ["BA"],
        evidence: [{ url: "https://ba.com/flight", title: "BA flight", domain: "ba.com" }]
      }]
    }));
    const worker = new FlightWorker({
      store, provider: { provider: "official_duffel", search } as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      workerId: "worker-1", leaseMs: 240_000, freshnessMs: 900_000, claimLimit: 1
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"ok":true,"result":{"message_id":42}}',
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    const result = await worker.tick(new Date("2026-08-01T12:00:00Z"));
    expect(result).toEqual({ scheduled: 0, processed: 0, notified: 0 });
    expect(search).toHaveBeenCalledTimes(0);
    const trip = (await store.listTrips(user.id))[0]!;
    expect(await store.getWatch(user.id, trip.id)).toBeNull();
    expect(await store.getRecommendation(user.id, trip.id)).toBeNull();
    expect(await store.getNotificationByTelegramMessage(user.id, 42)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("states the exact improvement in an alert", () => {
    const current = offerSnapshot("new", 90, 18_000);
    const previous = offerSnapshot("old", 100, 20_000);
    expect(notificationText({
      id: "notification",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "price_drop",
      attempts: 0,
      telegramMessageId: null,
      payload: {
        tripTitle: "Lagos",
        summary: "BA · LOS → LHR · GBP 90.00",
        snapshot: {
          current,
          previous,
          rankingMode: "cheapest",
          reasonCodes: ["lower_price"],
          createdAt: "2026-08-01T12:00:00.000Z"
        }
      }
    })).toContain("£10.00 less");
  });

  it("opens a trip with a concise, goal-oriented overview", () => {
    expect(notificationText({
      id: "first",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "initial_results",
      attempts: 0,
      telegramMessageId: null,
      payload: {
        tripTitle: "Lagos to London",
        tripGoal: "Get you LOS → LON on 10 Sept for the cheapest fare, "
          + "and tell you when it's the moment to buy.",
        range: { count: 14, low: 393.26, high: 812.5, currency: "USD" },
        snapshot: {
          current: offerSnapshot("current", 393.26, 7_200),
          previous: null,
          rankingMode: "cheapest",
          reasonCodes: ["initial_verified_result"],
          createdAt: "2026-08-01T12:00:00.000Z"
        }
      }
    })).toBe(
      "I found 14 fares for Lagos → London on 10 Sept, starting at $393.26.\n"
      + "Open the trip to compare the best options and choose one to watch. "
      + "I’ll check prices daily and only message you when something changes."
    );
  });

  it("says when tracking starts for a departure Captain is not yet watching daily", () => {
    expect(notificationText({
      id: "first",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "initial_results",
      attempts: 0,
      telegramMessageId: null,
      payload: {
        tripTitle: "Lagos to London",
        tripGoal: "Get you LOS → LON on 10 Dec for the cheapest fare.",
        range: { count: 1, low: 400, high: 400, currency: "USD" },
        trackingStartsAt: "2026-11-10"
      }
    })).toBe(
      "I found 1 fare for Lagos → London at $400.00.\n"
      + "Open the trip to compare the best options and choose one to watch. "
      + "Daily price checks start 10 Nov."
    );
  });

  it("turns a price rise into a clear booking decision", () => {
    expect(notificationText({
      id: "rise",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "price_rise",
      attempts: 0,
      telegramMessageId: null,
      payload: {
        tripTitle: "Lagos to London",
        tripGoal: "Get you LOS → LON on 10 Sept for under $400.",
        current: offerSnapshot("current", 430, 7_200),
        sevenDayLow: 393,
        increase: 37,
        percent: 9
      }
    })).toBe(
      "The BA fare you’re watching is up £37.00 (9%) this week.\n"
      + "Open the trip to decide whether to book now."
    );
  });

  it("uses a concise completed-run decision summary", () => {
    expect(notificationText({
      id: "notification",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "tracking_summary",
      attempts: 0,
      telegramMessageId: null,
      payload: {
        tripTitle: "Lagos to Abuja",
        durationHours: 72,
        checksCompleted: 12,
        summary: "British Airways is the best current option."
      }
    })).toBe(
      "Your price watch for Lagos → Abuja is complete. I checked 12 times.\n"
      + "British Airways is the best current option.\n"
      + "These prices are now stale. Open the trip and choose Track."
    );
  });

  it("keeps a manual-search trip out of legacy empty-search processing", async () => {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 3,
      telegramChatId: 3,
      username: null,
      firstName: "Ngozi",
      lastName: null
    }, new Date("2026-08-01T12:00:00Z"));
    const input: CreateTripInput = {
      title: "Lagos to Abuja",
      brief: {
        originAirports: ["LOS"],
        destinationAirports: ["ABV"],
        tripType: "one_way",
        departureWindow: { start: "2026-09-10", end: "2026-09-10" },
        stayNights: null,
        legs: [],
        travellers: { adults: 1, childrenAges: [], infants: 0 },
        cabin: "economy",
        maxStops: 1,
        currency: "USD",
        maximumPrice: null,
        preferredAirlines: [],
        excludedAirlines: [],
        context: ""
      }
    };
    await store.createTrip(
      user.id,
      input,
      buildSearchSpecs(input.brief, false),
      new Date("2026-08-01T12:00:00Z")
    );
    const search = vi.fn(async () => ({
      provider: "official_duffel" as const,
      requestId: "offreq_empty",
      discoveryResponseId: "offreq_empty",
      verificationResponseId: "offreq_empty",
      model: "duffel",
      promptVersion: "official_duffel",
      rejectionCounts: {},
      offers: []
    }));
    const worker = new FlightWorker({
      store,
      provider: { provider: "official_duffel", search } as unknown as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      workerId: "worker-1",
      leaseMs: 240_000,
      freshnessMs: 0,
      claimLimit: 1
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"ok":true,"result":{"message_id":77}}',
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    const first = await worker.tick(new Date("2026-08-01T12:00:00Z"));
    expect(first).toEqual({ scheduled: 0, processed: 0, notified: 0 });
    expect(await store.getNotificationByTelegramMessage(user.id, 77)).toBeNull();
    const createdTrip = (await store.listTrips(user.id))[0]!;
    expect(await store.getWatch(user.id, createdTrip.id)).toBeNull();

    const specs = buildSearchSpecs(input.brief, false);
    expect(await store.enqueueInventoryGapForSearchSpec(specs[0]!.id, new Date("2026-08-01T18:00:00Z")))
      .toBe(0);
    expect(search).toHaveBeenCalledTimes(0);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

function offerSnapshot(
  itineraryKey: string,
  price: number,
  durationSeconds: number
) {
  return {
    id: itineraryKey,
    searchRunId: "run",
    searchSpecId: "spec",
    itineraryKey,
    provider: "flysoar_mcp" as const,
    providerOfferId: itineraryKey,
    providerSearchId: "search",
    price,
    priceAmount: price.toFixed(2),
    currency: "GBP",
    fareBasis: "one_adult_total" as const,
    primaryAirlineCode: "BA",
    participatingAirlineCodes: ["BA"],
    evidence: [{ url: "https://ba.com/fare", title: "BA fare", domain: "ba.com" }],
    discoveryResponseId: "discovery",
    verificationResponseId: "verification",
    promptVersion: "v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:00.000Z",
    expiresAt: null,
    observedAt: "2026-08-01T12:00:00.000Z",
    snapshot: {
      durationSeconds,
      stops: 0,
      segments: [{
        airline: "BA",
        departure: "2026-09-10T09:00:00.000Z"
      }]
    }
  };
}
