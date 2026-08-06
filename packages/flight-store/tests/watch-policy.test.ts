import { describe, expect, it } from "vitest";

import type { CompletedProviderOffer } from "../src/contracts.js";
import {
  MAX_RETAINED_OFFERS_PER_SEARCH,
  MAX_TRACKING_RUN_MS,
  retainSearchOffers,
  TRACKING_CHECK_INTERVAL_MS,
  trackingRunEndsAt
} from "../src/watch-policy.js";

describe("efficient watch policy", () => {
  it("caps deduplicated offers, orders airlines representatively, and strips raw payloads", () => {
    const offers = Array.from({ length: 100 }, (_, index) => providerOffer(index));
    offers.push({
      ...providerOffer(100),
      itineraryKey: offers[0]!.itineraryKey,
      providerOfferId: "cheaper-duplicate",
      price: 50
    });

    const retained = retainSearchOffers(offers);

    expect(retained).toHaveLength(MAX_RETAINED_OFFERS_PER_SEARCH);
    expect(retained.find((offer) => offer.itineraryKey === offers[0]!.itineraryKey)?.price).toBe(50);
    expect(new Set(retained.map((offer) => offer.itineraryKey)).size).toBe(retained.length);
    expect(retained.every((offer) => !("raw" in offer.snapshot))).toBe(true);
    expect(retained.every((offer) => JSON.stringify(offer.snapshot).length < 4_000)).toBe(true);
    expect(new Set(retained.flatMap((offer) => offer.snapshot.airlineCodes as string[])).size).toBeGreaterThan(1);
    expect(new Set(retained.slice(0, 5).map((offer) => offer.primaryAirlineCode)).size)
      .toBe(5);
  });

  it("checks once a day", () => {
    expect(TRACKING_CHECK_INTERVAL_MS).toBe(24 * 3_600_000);
  });

  it("tracks a distant departure right up to the day of the flight", () => {
    const start = new Date("2026-08-01T12:00:00Z");
    expect(trackingRunEndsAt(start, "2027-03-14").toISOString())
      .toBe("2027-03-14T23:59:59.999Z");
    expect(trackingRunEndsAt(start, "2026-08-20").toISOString())
      .toBe("2026-08-20T23:59:59.999Z");
  });

  it("still earns one check when the departure is past or unreadable", () => {
    const start = new Date("2026-08-01T12:00:00Z");
    expect(trackingRunEndsAt(start, "2026-07-01").toISOString())
      .toBe("2026-08-02T12:00:00.000Z");
    expect(trackingRunEndsAt(start, "").getTime())
      .toBe(start.getTime() + MAX_TRACKING_RUN_MS);
  });

  it("caps a run whose departure is implausibly far out", () => {
    const start = new Date("2026-08-01T12:00:00Z");
    expect(trackingRunEndsAt(start, "2099-01-01").getTime())
      .toBe(start.getTime() + MAX_TRACKING_RUN_MS);
  });
});

function providerOffer(index: number): CompletedProviderOffer {
  const airlineCode = ["BA", "KL", "LH", "AF", "SK"][index % 5]!;
  return {
    itineraryKey: `${airlineCode}${100 + index}|LHR|BER|${index}`,
    provider: "flysoar_mcp",
    providerOfferId: `off_${index}`,
    providerSearchId: "orq_1",
    price: 100 + index,
    priceAmount: `${100 + index}.00`,
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode: airlineCode,
    participatingAirlineCodes: [airlineCode],
    evidence: [{ url: "https://example.com/flight", title: "Verified fare", domain: "example.com" }],
    discoveryResponseId: "resp_discovery",
    verificationResponseId: "resp_verification",
    promptVersion: "test-v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:01Z",
    expiresAt: "2026-08-01T12:30:00Z",
    observedAt: "2026-08-01T12:00:01Z",
    snapshot: {
      route: "LHR → BER",
      airlineCodes: [airlineCode],
      flightNumbers: [`${airlineCode}${100 + index}`],
      stops: index % 3,
      durationSeconds: 7_200 + index * 60,
      conditions: {},
      segments: [],
      raw: { oversized: "x".repeat(20_000) }
    }
  };
}
