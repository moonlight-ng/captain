import { describe, expect, it, vi } from "vitest";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import type { DuffelClient } from "@agents/provider-duffel";

import { FlightWorker } from "../src/worker.js";

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
        travellers: { adults: 1, childrenAges: [], infants: 0 }, cabin: "economy",
        maxStops: 1, currency: "GBP", maximumPrice: null,
        preferredAirlines: [], excludedAirlines: [], context: ""
      }
    };
    await store.createTrip(user.id, input, buildSearchSpecs(input.brief, false), new Date("2026-08-01T12:00:00Z"));
    const search = vi.fn(async () => ({
      searchId: "orq_1", searchedAt: "2026-08-01T12:00:01Z",
      offers: [{
        id: "off_1", searchId: "orq_1", price: 99, currency: "GBP",
        expiresAt: "2026-08-01T12:30:00Z", itineraryKey: "BA982|LHR|BER",
        segments: [{ airlineCode: "BA", airline: "British Airways", flightNumber: "BA982", origin: "LHR", destination: "BER", departure: "2026-09-10T09:00:00Z", arrival: "2026-09-10T11:00:00Z" }],
        conditions: {}, raw: {}
      }]
    }));
    const worker = new FlightWorker({
      store, duffel: { search } as unknown as DuffelClient,
      telegramBotToken: "test",
      workerId: "worker-1", leaseMs: 180_000, freshnessMs: 900_000, claimLimit: 4
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const result = await worker.tick(new Date("2026-08-01T12:00:00Z"));
    expect(result).toEqual({ scheduled: 1, processed: 1, notified: 1 });
    expect(search).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
