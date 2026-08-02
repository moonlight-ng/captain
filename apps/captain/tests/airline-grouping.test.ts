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

  it("exposes price and duration landscape across an airline’s offers", () => {
    const groups = airlineGroups([
      offer("cheap-short", "QR", ["QR"], 507, { durationSeconds: 56_400, stops: 1 }),
      offer("mid", "QR", ["QR"], 640, { durationSeconds: 64_800, stops: 1 }),
      offer("dear-long", "QR", ["QR"], 890, { durationSeconds: 79_200, stops: 0 }),
      offer("solo", "BA", ["BA"], 720, { durationSeconds: 50_400, stops: 0 })
    ]);

    expect(groups[0]).toMatchObject({
      airline: "QR",
      priceMax: 890,
      durationMinSeconds: 56_400,
      durationMaxSeconds: 79_200,
      stopMix: "1 stop · Nonstop"
    });
    expect(groups[0]!.cheapest.id).toBe("cheap-short");

    expect(groups[1]).toMatchObject({
      airline: "BA",
      priceMax: 720,
      durationMinSeconds: 50_400,
      durationMaxSeconds: 50_400,
      stopMix: "Nonstop"
    });
  });

  it("ignores non-positive durations when computing the duration landscape", () => {
    const [group] = airlineGroups([
      offer("known", "AA", ["AA"], 400, { durationSeconds: 36_000, stops: 0 }),
      offer("missing", "AA", ["AA"], 450, { durationSeconds: 0, stops: 1 })
    ]);

    expect(group).toMatchObject({
      priceMax: 450,
      durationMinSeconds: 36_000,
      durationMaxSeconds: 36_000,
      stopMix: "Nonstop · 1 stop"
    });
  });
});

function offer(
  id: string,
  primaryAirlineCode: string,
  participatingAirlineCodes: string[],
  price: number,
  snapshot: { durationSeconds?: number; stops?: number } = {}
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
      durationSeconds: snapshot.durationSeconds ?? 20_000,
      stops: snapshot.stops ?? participatingAirlineCodes.length - 1
    }
  };
}
