import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { SearchSpecRequest } from "@agents/flight-domain";
import { OpenAIWebFlightSearchProvider } from "@agents/provider-web";

type CorpusCase = {
  id: string;
  category: "nigerian_domestic" | "african_regional" | "long_haul";
  origin: string;
  destination: string;
  departureDate: string;
  currency: string;
};

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY is required for the live launch evaluation");
const corpus = JSON.parse(
  await readFile(resolve("evals/corpus.json"), "utf8")
) as CorpusCase[];
const provider = new OpenAIWebFlightSearchProvider({
  apiKey,
  ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
  ...(process.env.OPENAI_FLIGHT_MODEL ? { model: process.env.OPENAI_FLIGHT_MODEL } : {}),
  ...(process.env.FLIGHT_APPROVED_DOMAINS
    ? {
        approvedDomains: process.env.FLIGHT_APPROVED_DOMAINS
          .split(",")
          .map((domain) => domain.trim())
          .filter(Boolean)
      }
    : {})
});

const cases = [];
for (const item of corpus) {
  const startedAt = Date.now();
  const result = await provider.search(searchRequest(item));
  cases.push({
    id: item.id,
    category: item.category,
    verifiedOfferCount: result.offers.length,
    latencyMs: Date.now() - startedAt,
    responseIds: [result.discoveryResponseId, result.verificationResponseId],
    rejectionCounts: result.rejectionCounts,
    evidence: result.offers.flatMap((offer) =>
      offer.evidence.map((source) => ({
        itineraryKey: offer.itineraryKey,
        priceAmount: offer.priceAmount,
        currency: offer.currency,
        url: source.url,
        checkedAt: new Date().toISOString()
      }))
    )
  });
}

const coverage = cases.filter((item) => item.verifiedOfferCount >= 3).length / cases.length;
const p95LatencyMs = percentile(cases.map((item) => item.latencyMs), 0.95);
const manualSample = cases.flatMap((item) => item.evidence).slice(0, 50);
const manualAgreement = numberArgument("--manual-agreement=");
const passed = coverage >= 0.8
  && p95LatencyMs < 180_000
  && manualSample.length === 50
  && manualAgreement !== null
  && manualAgreement >= 0.9;

console.log(JSON.stringify({
  evaluatedAt: new Date().toISOString(),
  model: process.env.OPENAI_FLIGHT_MODEL?.trim() || "gpt-5.6-sol",
  thresholds: {
    coverageWithThreeOffers: 0.8,
    p95LatencyMs: 180_000,
    manualLandingAgreement: 0.9,
    manualSampleSize: 50
  },
  metrics: {
    coverageWithThreeOffers: coverage,
    p95LatencyMs,
    manualLandingAgreement: manualAgreement,
    manualSampleSize: manualSample.length
  },
  launchGate: passed ? "passed" : "failed",
  cases,
  manualSample
}, null, 2));

if (!passed) process.exitCode = 1;

function searchRequest(item: CorpusCase): SearchSpecRequest {
  return {
    provider: "openai_web",
    apiVersion: "v1",
    tripType: "one_way",
    slices: [{
      originAirports: [item.origin],
      destinationAirports: [item.destination],
      departureStart: item.departureDate,
      departureEnd: item.departureDate
    }],
    stayNights: null,
    passenger: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxConnections: 1,
    currency: item.currency,
    maximumPrice: null,
    fareContext: "public_beta"
  };
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function numberArgument(prefix: string): number | null {
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}
