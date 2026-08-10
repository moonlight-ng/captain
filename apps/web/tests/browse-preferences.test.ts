import { describe, expect, it } from "vitest";

import type { VerifiedOffer } from "../src/domain.js";
import {
  EMPTY_BROWSE_PREFERENCES,
  sortAndFilterOffers
} from "../src/domain.js";

describe("browse preferences", () => {
  it("filters by airline, stops, and max price then sorts by duration", () => {
    const offers = [
      offer("ba", "BA", 0, 1040, 23_400),
      offer("vs", "VS", 1, 910, 37_800),
      offer("et", "ET", 1, 820, 50_400)
    ];

    const filtered = sortAndFilterOffers(offers, {
      ...EMPTY_BROWSE_PREFERENCES,
      sort: "duration",
      stops: [1],
      airlines: ["VS", "ET"],
      maximumPrice: 900
    });

    expect(filtered.map((item) => item.id)).toEqual(["et"]);
  });

  it("keeps recommended order as price then duration", () => {
    const offers = [
      offer("slow-cheap", "ET", 1, 800, 50_000),
      offer("fast-same", "BA", 0, 800, 20_000),
      offer("pricey", "VS", 0, 1100, 18_000)
    ];

    expect(sortAndFilterOffers(offers, EMPTY_BROWSE_PREFERENCES).map((item) => item.id))
      .toEqual(["fast-same", "slow-cheap", "pricey"]);
  });
});

function offer(
  id: string,
  primaryAirlineCode: string,
  stops: number,
  price: number,
  durationSeconds: number
): VerifiedOffer {
  return {
    id,
    itineraryKey: id,
    provider: "flysoar_mcp",
    price,
    priceAmount: price.toFixed(2),
    currency: "USD",
    fareBasis: "one_adult_total",
    primaryAirlineCode,
    participatingAirlineCodes: [primaryAirlineCode],
    evidence: [{
      url: "https://example.com/fare",
      title: "Evidence",
      domain: "example.com"
    }],
    verifiedAt: "2026-08-01T12:00:00.000Z",
    observedAt: "2026-08-01T12:00:00.000Z",
    snapshot: {
      durationSeconds,
      stops
    }
  };
}
