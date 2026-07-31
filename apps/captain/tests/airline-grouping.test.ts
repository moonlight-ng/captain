import { describe, expect, it } from "vitest";

import type { VerifiedOffer } from "../src/domain.js";
import { airlineGroups } from "../src/airline-groups.js";

describe("Airlines view grouping", () => {
  it("counts a mixed itinerary once under its primary marketing airline", () => {
    const groups = airlineGroups([
      offer("mixed", "VS", ["VS", "KL"], 900),
      offer("virgin", "VS", ["VS"], 950),
      offer("klm", "KL", ["KL"], 920)
    ]);

    expect(groups.map((group) => group.airline)).toEqual(["VS", "KL"]);
    expect(groups[0]).toMatchObject({
      airline: "VS",
      mixed: true,
      offers: [{ id: "mixed" }, { id: "virgin" }]
    });
    expect(groups[1]).toMatchObject({
      airline: "KL",
      mixed: false,
      offers: [{ id: "klm" }]
    });
  });
});

function offer(
  id: string,
  primaryAirlineCode: string,
  participatingAirlineCodes: string[],
  price: number
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
    participatingAirlineCodes,
    evidence: [{
      url: "https://example.com/fare",
      title: "Evidence",
      domain: "example.com"
    }],
    verifiedAt: "2026-08-01T12:00:00.000Z",
    observedAt: "2026-08-01T12:00:00.000Z",
    snapshot: {
      durationSeconds: 20_000,
      stops: participatingAirlineCodes.length - 1
    }
  };
}
