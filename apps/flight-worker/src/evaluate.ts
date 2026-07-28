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

const cases: Array<{
  id: string;
  category: CorpusCase["category"];
  maxConnections: number;
  verifiedOfferCount: number;
  latencyMs: number;
  responseIds: string[];
  rejectionCounts: Record<string, number | undefined>;
  evidence: Array<{
    itineraryKey: string;
    priceAmount: string;
    currency: string;
    url: string;
    checkedAt: string;
  }>;
}> = [];
for (const item of corpus) {
  const startedAt = Date.now();
  const result = await provider.search(searchRequest(item));
  cases.push({
    id: item.id,
    category: item.category,
    maxConnections: maxConnectionsFor(item.category),
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

const byCategory = Object.fromEntries(
  (["nigerian_domestic", "african_regional", "long_haul"] as const).map((category) => {
    const subset = cases.filter((item) => item.category === category);
    const covered = subset.filter((item) => item.verifiedOfferCount >= 3).length;
    return [category, {
      cases: subset.length,
      coverageWithThreeOffers: subset.length === 0 ? 0 : covered / subset.length
    }];
  })
) as Record<string, { cases: number; coverageWithThreeOffers: number }>;

const coverage = cases.filter((item) => item.verifiedOfferCount >= 3).length / cases.length;
const domesticCoverage = byCategory.nigerian_domestic?.coverageWithThreeOffers ?? 0;
const internationalCoverage = cases
  .filter((item) => item.category !== "nigerian_domestic")
  .filter((item) => item.verifiedOfferCount >= 3).length
  / Math.max(1, cases.filter((item) => item.category !== "nigerian_domestic").length);
const p95LatencyMs = percentile(cases.map((item) => item.latencyMs), 0.95);
const manualSample = cases.flatMap((item) => item.evidence).slice(0, 50);
const manualAgreement = numberArgument("--manual-agreement=");
const passed = coverage >= 0.8
  && domesticCoverage >= 0.75
  && internationalCoverage >= 0.75
  && p95LatencyMs < 300_000
  && (manualAgreement === null || (manualSample.length > 0 && manualAgreement >= 0.9));

console.log(JSON.stringify({
  evaluatedAt: new Date().toISOString(),
  model: process.env.OPENAI_FLIGHT_MODEL?.trim() || "gpt-5.6-sol",
  inventoryProvider: "openai_web",
  thresholds: {
    coverageWithThreeOffers: 0.8,
    domesticCoverageWithThreeOffers: 0.75,
    internationalCoverageWithThreeOffers: 0.75,
    p95LatencyMs: 300_000,
    manualLandingAgreement: 0.9
  },
  metrics: {
    coverageWithThreeOffers: coverage,
    domesticCoverageWithThreeOffers: domesticCoverage,
    internationalCoverageWithThreeOffers: internationalCoverage,
    p95LatencyMs,
    manualLandingAgreement: manualAgreement,
    manualSampleSize: manualSample.length,
    byCategory
  },
  launchGate: passed ? "passed" : "failed",
  cases,
  manualSample
}, null, 2));

if (!passed) process.exitCode = 1;

function maxConnectionsFor(category: CorpusCase["category"]): number {
  return category === "nigerian_domestic" ? 1 : 2;
}

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
    maxConnections: maxConnectionsFor(item.category),
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
