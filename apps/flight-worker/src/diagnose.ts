import type { SearchSpecRequest } from "@agents/flight-domain";
import { OpenAIWebFlightSearchProvider } from "@agents/provider-web";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const provider = new OpenAIWebFlightSearchProvider({
  apiKey,
  ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
  ...(process.env.OPENAI_FLIGHT_MODEL ? { model: process.env.OPENAI_FLIGHT_MODEL } : {})
});

const cases: Array<{ id: string; request: SearchSpecRequest }> = [
  {
    id: "domestic-los-abv-ngn",
    request: {
      provider: "openai_web",
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
      currency: "NGN",
      maximumPrice: null,
      fareContext: "public_beta"
    }
  },
  {
    id: "longhaul-los-lhr-usd",
    request: {
      provider: "openai_web",
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
      webSearchCalls: result.webSearchCalls,
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
