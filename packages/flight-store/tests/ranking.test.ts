import type { OfferSnapshot, TravellerProfile, TripBrief } from "@agents/flight-domain";
import { describe, expect, it } from "vitest";

import { meetsAlertThreshold, rankOffers } from "../src/ranking.js";

const brief: TripBrief = {
  originAirports: ["LOS"],
  destinationAirports: ["LHR"],
  tripType: "one_way",
  departureWindow: { start: "2026-09-10", end: "2026-09-10" },
  stayNights: null,
  travellers: { adults: 1, childrenAges: [], infants: 0 },
  cabin: "economy",
  maxStops: 1,
  currency: "GBP",
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: [],
  context: ""
};

const slowCheap = offer("slow-cheap", 100, 36_000, 1, "BA", ["BA"]);
const fastPreferred = offer("fast-preferred", 110, 18_000, 0, "VS", ["VS"]);

describe("deterministic offer ranking", () => {
  it("applies Cheapest, Fastest, and Balanced rules exactly", () => {
    expect(rank("cheapest")[0]?.offer.itineraryKey).toBe("slow-cheap");
    expect(rank("fastest")[0]?.offer.itineraryKey).toBe("fast-preferred");
    expect(rank("balanced")[0]?.offer.itineraryKey).toBe("fast-preferred");
  });

  it("removes an itinerary when any participating airline is excluded", () => {
    const mixed = offer("mixed", 90, 15_000, 0, "BA", ["BA", "VS"]);
    const ranked = rankOffers(brief, profile("cheapest", [], ["VS"]), [
      mixed,
      slowCheap
    ]);
    expect(ranked.map(({ offer: candidate }) => candidate.itineraryKey)).toEqual(["slow-cheap"]);
  });

  it("uses inclusive 5% price and 10% duration improvement thresholds", () => {
    const previous = {
      offer: offer("previous", 100, 20_000, 0, "BA", ["BA"]),
      score: 1
    };

    expect(meetsAlertThreshold(
      "cheapest",
      { offer: offer("five-percent", 95, 20_000, 0, "BA", ["BA"]), score: 0.95 },
      previous
    )).toBe(true);
    expect(meetsAlertThreshold(
      "cheapest",
      { offer: offer("under-five", 95.01, 20_000, 0, "BA", ["BA"]), score: 0.9501 },
      previous
    )).toBe(false);
    expect(meetsAlertThreshold(
      "fastest",
      { offer: offer("ten-percent", 100, 18_000, 0, "BA", ["BA"]), score: 18_000 },
      previous
    )).toBe(true);
    expect(meetsAlertThreshold(
      "fastest",
      { offer: offer("under-ten", 100, 18_001, 0, "BA", ["BA"]), score: 18_001 },
      previous
    )).toBe(false);
  });

  it("requires a 10% Balanced score improvement", () => {
    const previous = { offer: slowCheap, score: 0.5 };
    expect(meetsAlertThreshold(
      "balanced",
      { offer: fastPreferred, score: 0.45 },
      previous
    )).toBe(true);
    expect(meetsAlertThreshold(
      "balanced",
      { offer: fastPreferred, score: 0.451 },
      previous
    )).toBe(false);
  });
});

function rank(mode: TravellerProfile["rankingMode"]) {
  return rankOffers(brief, profile(mode, ["VS"], []), [slowCheap, fastPreferred]);
}

function profile(
  rankingMode: TravellerProfile["rankingMode"],
  preferredAirlineCodes: string[],
  excludedAirlineCodes: string[]
): TravellerProfile {
  return {
    userId: "user",
    defaultCurrency: "GBP",
    rankingMode,
    preferredAirlineCodes,
    excludedAirlineCodes,
    alertsEnabled: true,
    notificationMode: "smart",
    digestHourLocal: 9,
    priceRiseAlertsEnabled: true,
    betterOptionAlertsEnabled: true,
    trackingCheckinsEnabled: true,
    maxAlertsPerDay: 1,
    quietHoursEnabled: true,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    onboardingStep: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function offer(
  itineraryKey: string,
  price: number,
  durationSeconds: number,
  stops: number,
  primaryAirlineCode: string,
  participatingAirlineCodes: string[]
): OfferSnapshot {
  return {
    id: itineraryKey,
    searchRunId: "run",
    searchSpecId: "spec",
    itineraryKey,
    provider: "flysoar_mcp",
    providerOfferId: itineraryKey,
    providerSearchId: "search",
    price,
    priceAmount: String(price),
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode,
    participatingAirlineCodes,
    evidence: [{ url: "https://example.com", title: "Evidence", domain: "example.com" }],
    discoveryResponseId: "discovery",
    verificationResponseId: "verification",
    promptVersion: "v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
    observedAt: "2026-08-01T00:00:00.000Z",
    snapshot: { durationSeconds, stops }
  };
}
