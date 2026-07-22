import { describe, expect, it, vi } from "vitest";

import { DuffelClient } from "../src/index.js";

describe("Duffel provider", () => {
  it("preserves offer expiry and canonical itinerary identity", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
      id: "orq_1",
      offers: [{
        id: "off_1",
        expires_at: "2026-09-01T12:30:00Z",
        total_amount: "120.50",
        total_currency: "GBP",
        owner: { name: "British Airways", iata_code: "BA" },
        slices: [{ segments: [{
          origin: { iata_code: "LHR" }, destination: { iata_code: "BER" },
          departing_at: "2026-09-10T09:00:00+01:00", arriving_at: "2026-09-10T11:50:00+02:00",
          marketing_carrier: { name: "British Airways", iata_code: "BA" },
          marketing_carrier_flight_number: "982", passengers: [{ cabin_class: "economy" }]
        }] }]
      }]
    } }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new DuffelClient({ accessToken: "test", fetch });
    const result = await client.search({
      provider: "duffel", apiVersion: "v2", liveMode: false,
      slices: [{ origin: "LHR", destination: "BER", departureDate: "2026-09-10" }],
      passengers: [{ type: "adult" }], cabin: "economy", maxConnections: 1, fareContext: "public"
    });
    expect(result.offers[0]).toMatchObject({
      id: "off_1", expiresAt: "2026-09-01T12:30:00Z", price: 120.5
    });
    expect(result.offers[0]!.itineraryKey).toContain("BA982|LHR|BER");
  });
});
