import { describe, expect, it } from "vitest";

import type { CompletedProviderOffer } from "../src/contracts.js";
import {
  adaptiveWatchIntervalMs,
  MAX_RETAINED_OFFERS_PER_SEARCH,
  retainSearchOffers,
  trackingStartsAt
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

  it("uses six-hour active checks until the final seven days, then three-hour checks", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(adaptiveWatchIntervalMs(1, "2026-08-20", now)).toBe(6 * 3_600_000);
    expect(adaptiveWatchIntervalMs(1, "2026-08-09", now)).toBe(6 * 3_600_000);
    expect(adaptiveWatchIntervalMs(1, "2026-08-05", now)).toBe(3 * 3_600_000);
    expect(adaptiveWatchIntervalMs(12, "2026-08-05", now)).toBe(3 * 3_600_000);
  });

  it("starts scheduled tracking exactly 30 days before departure", () => {
    expect(trackingStartsAt("2026-09-30").toISOString()).toBe("2026-08-31T00:00:00.000Z");
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
