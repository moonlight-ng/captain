import { describe, expect, it, vi } from "vitest";

import {
  HttpPilotResearchClient,
  buildResearchRequest
} from "../services/bridge/pilot-client.js";
import type { FlightSnapshot } from "../services/domain/types.js";
import { defaultTestBrief } from "./support.js";

describe("Pilot research bridge", () => {
  it("sends only public itinerary facts, constraints, and fare movements", () => {
    const flight: FlightSnapshot = {
      provider: "duffel",
      sourceName: "Duffel",
      sourceUrl: null,
      bookingUrl: null,
      evidence: "direct",
      providerOfferId: "off_public",
      providerSearchId: "orq_public",
      observedAt: "2026-08-01T00:00:00Z",
      origin: "LHR",
      destination: "JFK",
      travelDate: "2026-09-01",
      returnDate: null,
      marketingAirlineCode: "BA",
      marketingAirline: "British Airways",
      flightNumber: "BA117",
      route: "LHR → JFK",
      departure: "2026-09-01T10:00:00Z",
      arrival: "2026-09-01T18:00:00Z",
      durationSeconds: 28_800,
      stops: 0,
      cabin: "economy",
      price: 500,
      currency: "GBP",
      rank: 1,
      passengerCount: 1,
      segments: [{
        airlineCode: "BA",
        airline: "British Airways",
        flightNumber: "BA117",
        origin: "LHR",
        destination: "JFK",
        departure: "2026-09-01T10:00:00Z",
        arrival: "2026-09-01T18:00:00Z"
      }],
      conditions: {}
    };
    const payload = buildResearchRequest({
      agentKey: "fa_public",
      checkId: "00000000-0000-4000-8000-000000000001",
      brief: defaultTestBrief({ context: "private free-form note" }),
      flights: [flight],
      movements: [{
        destination: "JFK",
        travelDate: "2026-09-01",
        marketingAirline: "British Airways",
        currentPrice: 500,
        previousPrice: 550,
        currency: "GBP",
        changePercent: -9.09
      }]
    });
    expect(payload.publicContext).toMatchObject({
      origins: ["LHR"],
      destinations: ["JFK"],
      fareMovements: [{ currentPrice: 500, previousPrice: 550 }]
    });
    expect(JSON.stringify(payload)).not.toContain("private free-form note");
    expect(JSON.stringify(payload)).not.toContain("travellers");
    expect(JSON.stringify(payload)).not.toContain("off_public");
  });

  it("keeps only sanitized model, token, duration, and result metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      result: {
        searchedAt: "2026-08-01T00:00:00Z",
        overview: "No disruption found.",
        results: [],
        offers: [],
        gaps: []
      },
      metadata: {
        model: "gpt-test",
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        durationMs: 25
      }
    })) as unknown as typeof fetch;
    const client = new HttpPilotResearchClient({
      baseUrl: "https://captain.example",
      secret: "secret",
      fetch: fetchMock
    });
    const result = await client.research({
      agentKey: "fa_public",
      checkId: "00000000-0000-4000-8000-000000000001",
      brief: defaultTestBrief(),
      flights: [],
      movements: []
    });
    expect(result.metadata).toEqual({
      model: "gpt-test",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      durationMs: 25
    });
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("rawOutput");
  });
});
