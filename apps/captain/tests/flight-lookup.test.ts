import { describe, expect, it } from "vitest";

import {
  type FlightSearchProvider,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { FlightLookupService } from "../services/flights/lookup.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

const now = new Date("2026-08-07T12:00:00.000Z");

describe("Flight lookup", () => {
  it("searches a confirmed draft without creating the trip", async () => {
    const { store, trips, planning, user } = await setup();
    const prepared = await planning.prepare(
      user.id,
      "Lagos to London September 6 2026"
    );
    expect(prepared.status).toBe("awaiting_confirmation");
    if (prepared.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const provider = fakeProvider([
      liveOffer("BA", "British Airways", "780.00"),
      liveOffer("VS", "Virgin Atlantic", "740.00")
    ]);
    const lookup = new FlightLookupService({ store, trips, provider, now: () => now });

    const result = await lookup.search(user.id, { airlineCode: "BA" });

    expect(result).toMatchObject({
      status: "found",
      source: "live_prepared_trip",
      tripId: null,
      draftId: prepared.draft.id,
      airlineCode: "BA",
      route: "LOS → LON",
      matchingOfferCount: 1
    });
    expect(result.offers[0]).toMatchObject({
      priceAmount: "780.00",
      primaryAirlineCode: "BA",
      flightNumbers: ["BA74"]
    });
    expect(provider.calls).toBe(1);
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("does not schedule a background run for a saved manual-search trip", async () => {
    const { store, trips, user } = await setup();
    const created = await trips.create(user.id, {
      title: "London to New York",
      brief: defaultTestBrief()
    });
    expect(await store.scheduleDueSearchRuns(now, 900_000, 1)).toBe(0);
    expect(await store.claimSearchRuns("worker-test", now, 180_000, 1)).toEqual([]);
    const provider = fakeProvider([liveOffer("BA", "British Airways", "640.00")]);
    const lookup = new FlightLookupService({
      store,
      trips,
      provider,
      now: () => new Date("2026-08-07T12:00:02.000Z")
    });

    const result = await lookup.search(user.id, {
      tripId: created.trip.id,
      airlineCode: "ba"
    });

    expect(result).toMatchObject({
      status: "found",
      source: "live_trip",
      tripId: created.trip.id,
      storedOfferCount: 0,
      matchingOfferCount: 1
    });
    expect(result.offers[0]?.priceAmount).toBe("640.00");
    expect(provider.calls).toBe(1);
  });

  it("reports no match when a requested airline is absent from live results", async () => {
    const { store, trips, user } = await setup();
    await trips.create(user.id, {
      title: "London to New York",
      brief: defaultTestBrief()
    });
    const provider = fakeProvider([liveOffer("VS", "Virgin Atlantic", "680.00")]);
    const lookup = new FlightLookupService({
      store,
      trips,
      provider,
      now: () => new Date("2026-08-07T12:00:02.000Z")
    });

    const result = await lookup.search(user.id, { airlineCode: "BA" });

    expect(result).toMatchObject({
      status: "no_matches",
      source: "live_trip",
      storedOfferCount: 0,
      matchingOfferCount: 0
    });
    expect(result.offers).toEqual([]);
    expect(provider.calls).toBe(1);
  });
});

async function setup() {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: 42,
    telegramChatId: 42,
    username: null,
    firstName: "Ada",
    lastName: null
  }, now);
  const trips = new TripService({ store, now: () => now });
  const planning = new TripPlanningService({
    store,
    trips,
    apiKey: null,
    now: () => now
  });
  return { store, user, trips, planning };
}

function fakeProvider(offers: VerifiedOfferCandidate[]): FlightSearchProvider & { calls: number } {
  return {
    provider: "official_duffel",
    calls: 0,
    async search() {
      this.calls += 1;
      return {
        provider: "official_duffel",
        requestId: `request-${this.calls}`,
        discoveryResponseId: `request-${this.calls}`,
        verificationResponseId: `request-${this.calls}`,
        model: "duffel",
        promptVersion: "test",
        offers,
        rejectionCounts: {}
      };
    }
  };
}

function liveOffer(
  airlineCode: string,
  airline: string,
  priceAmount: string
): VerifiedOfferCandidate {
  return {
    itineraryKey: `${airlineCode}-live-itinerary`,
    providerOfferId: `${airlineCode}-offer`,
    expiresAt: "2026-08-08T12:00:00.000Z",
    priceAmount,
    currency: "USD",
    fareBasis: "one_adult_total",
    cabin: "economy",
    slices: [{
      origin: "LOS",
      destination: "LHR",
      departureDate: "2026-09-06",
      segments: [{
        origin: "LOS",
        destination: "LHR",
        departure: "2026-09-06T09:00:00.000Z",
        arrival: "2026-09-06T15:30:00.000Z",
        marketingAirlineCode: airlineCode,
        marketingAirline: airline,
        flightNumber: `${airlineCode}74`
      }]
    }],
    primaryAirlineCode: airlineCode,
    participatingAirlineCodes: [airlineCode],
    evidence: [{
      url: `https://duffel.com/air/offers/${airlineCode}-offer`,
      title: `${airline} offer`,
      domain: "duffel.com"
    }]
  };
}
