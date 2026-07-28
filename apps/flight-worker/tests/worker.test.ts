import { describe, expect, it, vi } from "vitest";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import type { FlightSearchProvider } from "@agents/provider-web";

import { FlightWorker, notificationText } from "../src/worker.js";

describe("flight worker orchestration", () => {
  it("runs one shared search and fans results out", async () => {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null
    }, new Date("2026-08-01T12:00:00Z"));
    const input: CreateTripInput = {
      title: "Berlin", cadenceHours: 6,
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
      requestId: "resp_discovery:resp_verify",
      discoveryResponseId: "resp_discovery",
      verificationResponseId: "resp_verify",
      model: "gpt-5.6-sol",
      promptVersion: "test-v1",
      rejectionCounts: {},
      webSearchCalls: 2,
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
      store, provider: { provider: "openai_web", search } as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      dailyResponseLimit: 500,
      workerId: "worker-1", leaseMs: 240_000, freshnessMs: 900_000, claimLimit: 1
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"ok":true,"result":{"message_id":42}}',
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    const result = await worker.tick(new Date("2026-08-01T12:00:00Z"));
    expect(result).toEqual({ scheduled: 1, processed: 1, notified: 1 });
    expect(search).toHaveBeenCalledTimes(1);
    const sent = await store.getNotificationByTelegramMessage(user.id, 42);
    expect(sent).toMatchObject({
      telegramMessageId: 42,
      payload: {
        snapshot: {
          current: {
            evidence: [{ url: "https://ba.com/flight" }]
          }
        }
      }
    });
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const telegramPayload = JSON.parse(String(request?.body)) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    };
    expect(telegramPayload.reply_markup.inline_keyboard[0]?.[0]?.text).toBe("Open trip");
    expect(telegramPayload.reply_markup.inline_keyboard[0]?.[0]?.url)
      .toMatch(/^https:\/\/captain\.example\.com\/trip#access=/u);
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

  it("states an inventory coverage gap without inventing fares", () => {
    expect(notificationText({
      id: "notification",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "inventory_gap",
      attempts: 0,
      telegramMessageId: null,
      payload: { tripTitle: "Lagos to Abuja" }
    })).toContain("doesn’t cover these airlines/routes");
  });

  it("defers a run without calling the provider when the daily ceiling is reached", async () => {
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 2,
      telegramChatId: 2,
      username: null,
      firstName: "Toni",
      lastName: null
    }, new Date("2026-08-01T12:00:00Z"));
    const input: CreateTripInput = {
      title: "Berlin",
      cadenceHours: 6,
      brief: {
        originAirports: ["LHR"],
        destinationAirports: ["BER"],
        tripType: "one_way",
        departureWindow: { start: "2026-09-10", end: "2026-09-10" },
        stayNights: null,
        legs: [],
        travellers: { adults: 1, childrenAges: [], infants: 0 },
        cabin: "economy",
        maxStops: 1,
        currency: "GBP",
        maximumPrice: null,
        preferredAirlines: [],
        excludedAirlines: [],
        context: ""
      }
    };
    const created = await store.createTrip(
      user.id,
      input,
      buildSearchSpecs(input.brief, false),
      new Date("2026-08-01T12:00:00Z")
    );
    const search = vi.fn();
    const worker = new FlightWorker({
      store,
      provider: { provider: "openai_web", search } as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      dailyResponseLimit: 1,
      workerId: "worker-1",
      leaseMs: 240_000,
      freshnessMs: 900_000,
      claimLimit: 1
    });

    await expect(worker.tick(new Date("2026-08-01T12:00:00Z"))).resolves.toEqual({
      scheduled: 1,
      processed: 1,
      notified: 0
    });
    expect(search).not.toHaveBeenCalled();
    expect(await store.getWatch(user.id, created.trip.id)).toMatchObject({
      delayReason: "Daily OpenAI Responses safety ceiling reached; tracking is delayed."
    });
  });

  it("queues a one-shot inventory_gap notice when a search returns no offers", async () => {
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
      cadenceHours: 6,
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
      requestId: "offreq_empty",
      discoveryResponseId: "offreq_empty",
      verificationResponseId: "offreq_empty",
      model: "duffel",
      promptVersion: "official_duffel",
      rejectionCounts: {},
      webSearchCalls: 0,
      offers: []
    }));
    const worker = new FlightWorker({
      store,
      provider: { provider: "official_duffel", search } as unknown as FlightSearchProvider,
      telegramBotToken: "test",
      captainPublicUrl: "https://captain.example.com",
      trackingEnabled: true,
      dailyResponseLimit: 500,
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
    expect(first).toEqual({ scheduled: 1, processed: 1, notified: 1 });
    const sent = await store.getNotificationByTelegramMessage(user.id, 77);
    expect(sent).toMatchObject({ kind: "inventory_gap" });
    expect(notificationText(sent!)).toContain("doesn’t cover these airlines/routes");

    const specs = buildSearchSpecs(input.brief, false);
    expect(await store.enqueueInventoryGapForSearchSpec(specs[0]!.id, new Date("2026-08-01T18:00:00Z")))
      .toBe(0);
    expect(search).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
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
    provider: "openai_web" as const,
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
    snapshot: { durationSeconds, stops: 0 }
  };
}
