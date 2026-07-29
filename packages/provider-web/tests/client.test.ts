import type { SearchSpecRequest } from "@agents/flight-domain";
import { describe, expect, it, vi } from "vitest";

import { OpenAIWebFlightSearchProvider } from "../src/index.js";

const request: SearchSpecRequest = {
  provider: "openai_web",
  apiVersion: "v1",
  tripType: "one_way",
  slices: [{
    originAirports: ["LOS"],
    destinationAirports: ["ABV"],
    departureStart: "2026-09-10",
    departureEnd: "2026-09-10"
  }],
  stayNights: null,
  passenger: { adults: 1, childrenAges: [], infants: 0 },
  cabin: "economy",
  maxConnections: 1,
  currency: "NGN",
  maximumPrice: null,
  fareContext: "public_beta"
};

const offer = {
  itineraryKey: "provider-key",
  priceAmount: "155000",
  currency: "NGN",
  fareBasis: "one_adult_total",
  cabin: "economy",
  slices: [{
    origin: "LOS",
    destination: "ABV",
    departureDate: "2026-09-10",
    segments: [{
      origin: "LOS",
      destination: "ABV",
      departure: "2026-09-10T08:00:00+01:00",
      arrival: "2026-09-10T09:10:00+01:00",
      marketingAirlineCode: "P4",
      marketingAirline: "Air Peace",
      flightNumber: "P47120"
    }]
  }],
  primaryAirlineCode: "P4",
  participatingAirlineCodes: ["P4"],
  evidence: [{
    url: "https://www.flyairpeace.com/search/result",
    title: "Air Peace flight result",
    domain: "flyairpeace.com"
  }]
};

describe("OpenAI web flight provider", () => {
  it("retains only an exact two-pass match backed by retrieved approved sources", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [offer]))
      .mockResolvedValueOnce(response("verification", [offer]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.discoveryResponseId).toBe("discovery");
    expect(result.verificationResponseId).toBe("verification");
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.itineraryKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.webSearchCalls).toBe(2);
  });

  it("retains a two-pass match when evidence URLs differ but itinerary and fare match", async () => {
    const changed = {
      ...offer,
      evidence: [{
        ...offer.evidence[0]!,
        url: "https://www.flyairpeace.com/search/other"
      }]
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [offer]))
      .mockResolvedValueOnce(response("verification", [changed], "https://www.flyairpeace.com/search/other"));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toHaveLength(1);
    expect(result.rejectionCounts.two_pass_mismatch ?? 0).toBe(0);
  });

  it("accepts evidence when a same-domain source was retrieved even if the exact URL differs", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [offer], "https://www.flyairpeace.com/home"))
      .mockResolvedValueOnce(response("verification", [offer], "https://www.flyairpeace.com/home"));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toHaveLength(1);
  });

  it("rejects a verification pass whose fare changed", async () => {
    const changed = { ...offer, priceAmount: "160000" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [offer]))
      .mockResolvedValueOnce(response("verification", [changed]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toEqual([]);
    expect(result.rejectionCounts.two_pass_mismatch).toBe(1);
  });

  it("does not accept a candidate seen in only one of the two passes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", []))
      .mockResolvedValueOnce(response("retry", [offer]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.discoveryResponseId).toBe("discovery");
    expect(result.verificationResponseId).toBe("retry");
    expect(result.offers).toEqual([]);
  });

  it("returns more than 20 verified offers and interleaves distinct airlines", async () => {
    const offers = Array.from({ length: 27 }, (_, index) => {
      const airline = ["P4", "UA", "BA"][index % 3]!;
      const hour = String(1 + Math.floor(index / 3)).padStart(2, "0");
      return {
        ...offer,
        priceAmount: `${155000 + index}`,
        primaryAirlineCode: airline,
        participatingAirlineCodes: [airline],
        slices: [{
          ...offer.slices[0]!,
          segments: [{
            ...offer.slices[0]!.segments[0]!,
            departure: `2026-09-10T${hour}:00:00+01:00`,
            arrival: `2026-09-10T${hour}:50:00+01:00`,
            marketingAirlineCode: airline,
            marketingAirline: airline,
            flightNumber: `${airline}${100 + index}`
          }]
        }]
      };
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", offers))
      .mockResolvedValueOnce(response("verification", offers));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toHaveLength(27);
    expect(result.offers.slice(0, 3).map((item) => item.primaryAirlineCode))
      .toEqual(["P4", "UA", "BA"]);
    const firstRequest = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      input: string;
      max_tool_calls: number;
      text: { format: { schema: { properties: { offers: Record<string, unknown> } } } };
    };
    expect(firstRequest.input).toContain("every identified primary airline");
    expect(firstRequest.max_tool_calls).toBe(16);
    expect(firstRequest.text.format.schema.properties.offers).not.toHaveProperty("maxItems");
  });

  it("still performs the bounded verification response when discovery is empty", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", []))
      .mockResolvedValueOnce(response("verification", []));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.offers).toEqual([]);
    expect(result.verificationResponseId).toBe("verification");
  });

  it("keeps valid offers when another candidate in the same batch has invalid schema", async () => {
    const invalid = {
      ...offer,
      slices: [{ ...offer.slices[0]!, segments: [{ ...offer.slices[0]!.segments[0]!, departure: "not-a-date" }] }]
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [invalid, offer]))
      .mockResolvedValueOnce(response("verification", [offer]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toHaveLength(1);
    expect(result.rejectionCounts.invalid_schema).toBe(1);
  });

  it("coerces offset-less datetimes before validation", async () => {
    const offsetLess = {
      ...offer,
      slices: [{
        ...offer.slices[0]!,
        segments: [{
          ...offer.slices[0]!.segments[0]!,
          departure: "2026-09-10T08:00:00",
          arrival: "2026-09-10T09:10:00"
        }]
      }]
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [offsetLess]))
      .mockResolvedValueOnce(response("verification", [offsetLess]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.slices[0]?.segments[0]?.departure).toBe("2026-09-10T08:00:00Z");
  });

  it.each([
    ["route_mismatch", {
      ...offer,
      slices: [{ ...offer.slices[0]!, destination: "KAN" }]
    }],
    ["date_mismatch", {
      ...offer,
      slices: [{
        ...offer.slices[0]!,
        departureDate: "2026-09-11",
        segments: [{
          ...offer.slices[0]!.segments[0]!,
          departure: "2026-09-11T08:00:00+01:00",
          arrival: "2026-09-11T09:10:00+01:00"
        }]
      }]
    }],
    ["currency_mismatch", { ...offer, currency: "GBP", priceAmount: "100" }],
    ["segment_mismatch", {
      ...offer,
      slices: [{
        ...offer.slices[0]!,
        segments: [{ ...offer.slices[0]!.segments[0]!, origin: "ABV" }]
      }]
    }],
    ["unapproved_source", {
      ...offer,
      evidence: [{
        url: "https://unknown.example/flight",
        title: "Unknown source",
        domain: "unknown.example"
      }]
    }]
  ] as const)("rejects %s in both validation passes", async (reason, invalidOffer) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("discovery", [invalidOffer]))
      .mockResolvedValueOnce(response("verification", [invalidOffer]));
    const provider = new OpenAIWebFlightSearchProvider({
      apiKey: "test",
      approvedDomains: ["flyairpeace.com"],
      fetch
    });

    const result = await provider.search(request);

    expect(result.offers).toEqual([]);
    expect(result.rejectionCounts[reason]).toBe(2);
  });
});

function response(id: string, offers: unknown[], sourceUrl?: string): Response {
  const url = sourceUrl
    ?? (offers.length > 0
      ? (offers[0] as typeof offer).evidence[0]!.url
      : "https://www.flyairpeace.com/");
  return Response.json({
    id,
    status: "completed",
    output: [
      {
        type: "web_search_call",
        action: { type: "search", sources: [{ type: "url", url }] }
      },
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ offers }) }]
      }
    ]
  });
}
