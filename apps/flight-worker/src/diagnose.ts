import type { SearchSpecRequest } from "@agents/flight-domain";
import { DuffelFlightSearchProvider } from "@agents/provider-duffel";

const accessToken = process.env.DUFFEL_ACCESS_TOKEN?.trim();
if (!accessToken) throw new Error("DUFFEL_ACCESS_TOKEN is required");

const provider = new DuffelFlightSearchProvider({
  accessToken,
  ...(process.env.DUFFEL_BASE_URL ? { baseUrl: process.env.DUFFEL_BASE_URL } : {})
});

const cases: Array<{ id: string; request: SearchSpecRequest }> = [
  {
    id: "domestic-los-abv-ngn",
    request: {
      provider: "official_duffel",
      apiVersion: "v1",
      tripType: "one_way",
      slices: [{
        originAirports: ["LOS"],
        destinationAirports: ["ABV"],
        departureStart: "2026-08-20",
        departureEnd: "2026-08-20"
      }],
      stayNights: null,
      passenger: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxConnections: 1,
      currency: "USD",
      maximumPrice: null,
      fareContext: "public_beta"
    }
  },
  {
    id: "longhaul-los-lhr-usd",
    request: {
      provider: "official_duffel",
      apiVersion: "v1",
      tripType: "one_way",
      slices: [{
        originAirports: ["LOS"],
        destinationAirports: ["LHR"],
        departureStart: "2026-08-25",
        departureEnd: "2026-08-25"
      }],
      stayNights: null,
      passenger: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxConnections: 2,
      currency: "USD",
      maximumPrice: null,
      fareContext: "public_beta"
    }
  }
];

const results = [];
for (const item of cases) {
  const startedAt = Date.now();
  try {
    const result = await provider.search(item.request);
    results.push({
      id: item.id,
      ok: true,
      verifiedOfferCount: result.offers.length,
      rejectionCounts: result.rejectionCounts,
      latencyMs: Date.now() - startedAt,
      sample: result.offers.slice(0, 2).map((offer) => ({
        priceAmount: offer.priceAmount,
        currency: offer.currency,
        route: offer.slices.map((slice) => `${slice.origin}-${slice.destination}`).join("/"),
        evidenceDomains: offer.evidence.map((evidence) => evidence.domain)
      }))
    });
  } catch (error) {
    results.push({
      id: item.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt
    });
  }
}

console.log(JSON.stringify({ diagnosedAt: new Date().toISOString(), results }, null, 2));
