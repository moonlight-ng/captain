import { createHash } from "node:crypto";

import {
  verifiedOfferCandidateSchema,
  type SearchSpecRequest,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import { z } from "zod";

import { DEFAULT_APPROVED_FLIGHT_DOMAINS } from "./approved-domains.js";
import type {
  FlightSearchProvider,
  WebSearchRejectionReason,
  WebSearchResult
} from "./types.js";

const PROMPT_VERSION = "captain-web-fares-v2";
const MAX_DISCOVERY_OFFERS = 40;
const MAX_VERIFIED_OFFERS = 20;
const RESPONSE_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_TOOL_CALLS = 10;

const responseEnvelopeSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"]),
  output: z.array(z.unknown()).default([]),
  error: z.unknown().nullable().optional()
}).passthrough();

type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

export class WebSearchProviderError extends Error {
  constructor(
    readonly code: "unauthorized" | "rate_limited" | "unavailable" | "invalid_response" | "timeout",
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

export class OpenAIWebFlightSearchProvider implements FlightSearchProvider {
  readonly provider = "openai_web" as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #approvedDomains: string[];
  readonly #fetch: typeof fetch;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    approvedDomains?: string[];
    fetch?: typeof fetch;
  }) {
    this.#apiKey = options.apiKey.trim();
    if (!this.#apiKey) throw new Error("OPENAI_API_KEY is required");
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "");
    this.#model = options.model?.trim() || "gpt-5.6-sol";
    this.#approvedDomains = normalizeDomains(
      options.approvedDomains?.length ? options.approvedDomains : [...DEFAULT_APPROVED_FLIGHT_DOMAINS]
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async search(request: SearchSpecRequest): Promise<WebSearchResult> {
    const rejectionCounts: Partial<Record<WebSearchRejectionReason, number>> = {};
    const discovery = await this.#createResponse({
      schemaName: "flight_discovery",
      prompt: discoveryPrompt(request),
      maximumOffers: MAX_DISCOVERY_OFFERS
    });
    const discovered = parseAndValidateBatch(
      discovery,
      request,
      this.#approvedDomains,
      rejectionCounts
    );

    // When discovery finds nothing, run an independent second discovery instead of
    // "verifying" an empty list. Accept validated offers from that retry alone.
    if (discovered.length === 0) {
      const retry = await this.#createResponse({
        schemaName: "flight_discovery_retry",
        prompt: discoveryPrompt(request),
        maximumOffers: MAX_DISCOVERY_OFFERS
      });
      const retried = parseAndValidateBatch(
        retry,
        request,
        this.#approvedDomains,
        rejectionCounts
      );
      return {
        requestId: `${discovery.id}:${retry.id}`,
        discoveryResponseId: discovery.id,
        verificationResponseId: retry.id,
        model: this.#model,
        promptVersion: PROMPT_VERSION,
        offers: retried.slice(0, MAX_VERIFIED_OFFERS),
        rejectionCounts,
        webSearchCalls: countWebSearchCalls(discovery) + countWebSearchCalls(retry)
      };
    }

    const verification = await this.#createResponse({
      schemaName: "flight_verification",
      prompt: verificationPrompt(request, discovered),
      maximumOffers: MAX_VERIFIED_OFFERS
    });
    const verified = parseAndValidateBatch(
      verification,
      request,
      this.#approvedDomains,
      rejectionCounts
    );
    const discoveredByKey = new Map(discovered.map((offer) => [offer.itineraryKey, offer]));
    const accepted: VerifiedOfferCandidate[] = [];
    for (const candidate of verified) {
      const original = discoveredByKey.get(candidate.itineraryKey);
      if (!original || comparableOffer(original) !== comparableOffer(candidate)) {
        reject(rejectionCounts, "two_pass_mismatch");
        continue;
      }
      accepted.push(candidate);
      if (accepted.length >= MAX_VERIFIED_OFFERS) break;
    }

    return {
      requestId: `${discovery.id}:${verification.id}`,
      discoveryResponseId: discovery.id,
      verificationResponseId: verification.id,
      model: this.#model,
      promptVersion: PROMPT_VERSION,
      offers: accepted,
      rejectionCounts,
      webSearchCalls: countWebSearchCalls(discovery) + countWebSearchCalls(verification)
    };
  }

  async #createResponse(input: {
    schemaName: string;
    prompt: string;
    maximumOffers: number;
  }): Promise<ResponseEnvelope> {
    const response = await this.#request("/responses", {
      method: "POST",
      body: JSON.stringify({
        model: this.#model,
        reasoning: { effort: "medium" },
        background: true,
        store: true,
        tools: [{
          type: "web_search",
          external_web_access: true,
          search_context_size: "high"
        }],
        tool_choice: "required",
        max_tool_calls: MAX_TOOL_CALLS,
        include: ["web_search_call.action.sources"],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: input.schemaName,
            strict: true,
            schema: batchJsonSchema(input.maximumOffers)
          }
        },
        instructions: [
          "You are the evidence-gathering component of a public flight tracker.",
          "Search broadly, then prefer airline, metasearch, and OTA pages for evidence.",
          "Approved evidence domains include Google Flights, Skyscanner, Kayak, Momondo, Expedia, Trip.com, Travelstart, and major carriers.",
          "Return only fares supported by pages retrieved in this response.",
          "Never infer, convert, multiply, estimate, or repair a price.",
          "If a required field is absent, omit that itinerary.",
          "Evidence must cite an approved airline, metasearch, or OTA domain retrieved in this response.",
          "A fare is for exactly one adult and must include taxes when the source states that.",
          "Match the Trip currency exactly; do not convert currencies.",
          "Do not claim the result set is exhaustive."
        ].join("\n"),
        input: input.prompt
      })
    });
    let current = responseEnvelopeSchema.parse(await response.json());
    const startedAt = Date.now();
    while (current.status === "queued" || current.status === "in_progress") {
      if (Date.now() - startedAt >= RESPONSE_TIMEOUT_MS) {
        throw new WebSearchProviderError("timeout", "OpenAI web search timed out");
      }
      await delay(POLL_INTERVAL_MS);
      const polled = await this.#request(`/responses/${encodeURIComponent(current.id)}`, { method: "GET" });
      current = responseEnvelopeSchema.parse(await polled.json());
    }
    if (current.status !== "completed") {
      throw new WebSearchProviderError("unavailable", `OpenAI response ended with ${current.status}`);
    }
    return current;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          ...init.headers
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new WebSearchProviderError(
        "unavailable",
        error instanceof Error ? error.message : "OpenAI request failed"
      );
    }
    if (response.ok) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : null;
    if (response.status === 401 || response.status === 403) {
      throw new WebSearchProviderError("unauthorized", "OpenAI rejected the API credential");
    }
    if (response.status === 429) {
      throw new WebSearchProviderError("rate_limited", "OpenAI rate limit reached", retryAfterMs);
    }
    throw new WebSearchProviderError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      `OpenAI returned HTTP ${response.status}`,
      retryAfterMs
    );
  }
}

function parseAndValidateBatch(
  response: ResponseEnvelope,
  request: SearchSpecRequest,
  approvedDomains: string[],
  rejections: Partial<Record<WebSearchRejectionReason, number>>
): VerifiedOfferCandidate[] {
  const text = outputText(response);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject(rejections, "invalid_json");
    return [];
  }
  const record = object(value);
  if (!record || !Array.isArray(record.offers)) {
    reject(rejections, "invalid_schema");
    return [];
  }
  const retrievedSources = sourceUrls(response);
  const offers: VerifiedOfferCandidate[] = [];
  for (const raw of record.offers) {
    const coerced = coerceCandidate(raw);
    const parsed = verifiedOfferCandidateSchema.safeParse(coerced);
    if (!parsed.success) {
      reject(rejections, "invalid_schema");
      continue;
    }
    const normalized = normalizeCandidate(parsed.data);
    const rejection = validateCandidate(normalized, request, approvedDomains, retrievedSources);
    if (rejection) {
      reject(rejections, rejection);
      continue;
    }
    offers.push(normalized);
  }
  return offers;
}

function coerceCandidate(value: unknown): unknown {
  const record = object(value);
  if (!record || !Array.isArray(record.slices)) return value;
  return {
    ...record,
    slices: record.slices.map((slice) => {
      const sliceRecord = object(slice);
      if (!sliceRecord || !Array.isArray(sliceRecord.segments)) return slice;
      return {
        ...sliceRecord,
        segments: sliceRecord.segments.map((segment) => {
          const segmentRecord = object(segment);
          if (!segmentRecord) return segment;
          return {
            ...segmentRecord,
            departure: coerceDateTime(segmentRecord.departure),
            arrival: coerceDateTime(segmentRecord.arrival)
          };
        })
      };
    })
  };
}

function coerceDateTime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/u.test(trimmed)) {
    return `${trimmed.length === 16 ? `${trimmed}:00` : trimmed}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z$/u.test(trimmed)) return trimmed;
  return trimmed;
}

function normalizeCandidate(candidate: VerifiedOfferCandidate): VerifiedOfferCandidate {
  const slices = candidate.slices.map((slice) => ({
    ...slice,
    segments: slice.segments.map((segment) => ({
      ...segment,
      marketingAirlineCode: segment.marketingAirlineCode.toUpperCase()
    }))
  }));
  const participating = [...new Set(
    slices.flatMap((slice) => slice.segments.map((segment) => segment.marketingAirlineCode))
  )].sort();
  const canonical = {
    ...candidate,
    slices,
    primaryAirlineCode: candidate.primaryAirlineCode.toUpperCase(),
    participatingAirlineCodes: participating,
    evidence: candidate.evidence.map((evidence) => {
      const url = normalizeUrl(evidence.url);
      return { url, title: evidence.title, domain: new URL(url).hostname.toLowerCase() };
    })
  };
  canonical.itineraryKey = createHash("sha256")
    .update(JSON.stringify({
      slices: canonical.slices,
      primaryAirlineCode: canonical.primaryAirlineCode
    }))
    .digest("hex");
  return verifiedOfferCandidateSchema.parse(canonical);
}

function validateCandidate(
  candidate: VerifiedOfferCandidate,
  request: SearchSpecRequest,
  approvedDomains: string[],
  retrievedSources: Set<string>
): WebSearchRejectionReason | null {
  if (candidate.currency !== request.currency) return "currency_mismatch";
  if (candidate.fareBasis !== "one_adult_total") return "fare_basis_mismatch";
  if (candidate.cabin !== request.cabin) return "cabin_mismatch";
  if (request.maximumPrice !== null && Number(candidate.priceAmount) > request.maximumPrice) return "price_limit";
  const expectedSliceCount = request.tripType === "round_trip" ? 2 : request.slices.length;
  if (candidate.slices.length !== expectedSliceCount) return "route_mismatch";
  for (let index = 0; index < candidate.slices.length; index += 1) {
    const slice = candidate.slices[index]!;
    const expected = expectedSlice(request, candidate, index);
    if (!expected) return "route_mismatch";
    if (
      !expected.originAirports.includes(slice.origin)
      || !expected.destinationAirports.includes(slice.destination)
    ) return "route_mismatch";
    if (slice.departureDate < expected.departureStart || slice.departureDate > expected.departureEnd) {
      return "date_mismatch";
    }
    if (slice.segments.length - 1 > request.maxConnections) return "stop_limit";
    if (!validSegments(slice)) return "segment_mismatch";
  }
  if (!candidate.participatingAirlineCodes.includes(candidate.primaryAirlineCode)) return "segment_mismatch";
  for (const evidence of candidate.evidence) {
    if (!approvedDomain(evidence.domain, approvedDomains)) return "unapproved_source";
    if (!evidenceRetrieved(evidence.url, evidence.domain, retrievedSources)) {
      return "source_not_retrieved";
    }
  }
  return null;
}

function expectedSlice(
  request: SearchSpecRequest,
  candidate: VerifiedOfferCandidate,
  index: number
): {
  originAirports: string[];
  destinationAirports: string[];
  departureStart: string;
  departureEnd: string;
} | null {
  if (request.tripType !== "round_trip" || index === 0) return request.slices[index] ?? null;
  const outbound = candidate.slices[0]!;
  const stay = request.stayNights;
  if (!stay) return null;
  return {
    originAirports: request.slices[0]!.destinationAirports,
    destinationAirports: request.slices[0]!.originAirports,
    departureStart: addDays(outbound.departureDate, stay.minimum),
    departureEnd: addDays(outbound.departureDate, stay.maximum)
  };
}

function validSegments(slice: VerifiedOfferCandidate["slices"][number]): boolean {
  if (
    slice.segments[0]?.origin !== slice.origin
    || slice.segments.at(-1)?.destination !== slice.destination
  ) return false;
  for (let index = 0; index < slice.segments.length; index += 1) {
    const segment = slice.segments[index]!;
    if (
      Date.parse(segment.arrival) <= Date.parse(segment.departure)
      || (index === 0 && segment.departure.slice(0, 10) !== slice.departureDate)
    ) return false;
    const next = slice.segments[index + 1];
    if (
      next
      && (segment.destination !== next.origin || Date.parse(next.departure) <= Date.parse(segment.arrival))
    ) return false;
  }
  return true;
}

function comparableOffer(offer: VerifiedOfferCandidate): string {
  // Evidence URLs often change between passes (tracking params, deep links).
  // Itinerary, fare, cabin, and currency must still match exactly.
  return JSON.stringify({
    itineraryKey: offer.itineraryKey,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    fareBasis: offer.fareBasis,
    cabin: offer.cabin,
    slices: offer.slices,
    primaryAirlineCode: offer.primaryAirlineCode,
    participatingAirlineCodes: offer.participatingAirlineCodes
  });
}

function evidenceRetrieved(
  evidenceUrl: string,
  evidenceDomain: string,
  retrievedSources: Set<string>
): boolean {
  const normalizedEvidence = normalizeUrl(evidenceUrl);
  if (retrievedSources.has(normalizedEvidence)) return true;
  const domain = evidenceDomain.toLowerCase().replace(/^www\./u, "");
  for (const source of retrievedSources) {
    try {
      const host = new URL(source).hostname.toLowerCase().replace(/^www\./u, "");
      if (host === domain || host.endsWith(`.${domain}`)) return true;
    } catch {
      // Ignore malformed retrieved URLs.
    }
  }
  return false;
}

function outputText(response: ResponseEnvelope): string {
  for (const item of response.output) {
    const record = object(item);
    if (record?.type !== "message" || !Array.isArray(record.content)) continue;
    for (const content of record.content) {
      const part = object(content);
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function sourceUrls(response: ResponseEnvelope): Set<string> {
  const values = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = object(value);
    if (!record) return;
    if (typeof record.url === "string" && /^https:\/\//u.test(record.url)) {
      values.add(normalizeUrl(record.url));
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(response.output);
  return values;
}

function countWebSearchCalls(response: ResponseEnvelope): number {
  return response.output.filter((item) => object(item)?.type === "web_search_call").length;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|gclid|fbclid)/u.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function normalizeDomains(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^www\./u, "")))]
    .filter(Boolean)
    .slice(0, 100);
}

function approvedDomain(hostname: string, approved: string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./u, "");
  return approved.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function reject(
  counts: Partial<Record<WebSearchRejectionReason, number>>,
  reason: WebSearchRejectionReason
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoveryPrompt(request: SearchSpecRequest): string {
  return [
    "Find currently displayed, source-backed flight fares matching this exact Trip.",
    "Search approved airline, metasearch, and OTA sites broadly, including Google Flights when useful.",
    "Open fare result pages when search snippets lack flight numbers or times.",
    "Prefer itineraries within the requested maxConnections; include realistic one- and two-stop long-haul options when allowed.",
    "Return no more than 40 candidates.",
    "The price must be the displayed total for exactly one adult in the requested cabin and currency.",
    "Every slice must contain every flight segment, marketing airline, flight number, and departure/arrival timestamps.",
    "Use ISO-8601 local times with a UTC offset when the source shows one; otherwise use Zulu times from the published schedule.",
    "Trip request:",
    JSON.stringify(request)
  ].join("\n");
}

function verificationPrompt(request: SearchSpecRequest, candidates: VerifiedOfferCandidate[]): string {
  return [
    "Independently verify these discovered flight candidates with fresh web searches.",
    "Return only candidates whose source still shows the same route, dates, segments, flight numbers, cabin, one-adult fare, and currency.",
    "Preserve structured itinerary and fare values exactly; evidence URLs may differ if they are the same approved domain.",
    "Omit a candidate if route, dates, segments, cabin, fare, or currency cannot be confirmed.",
    "Return no more than 20 verified candidates.",
    "Trip request:",
    JSON.stringify(request),
    "Candidates:",
    JSON.stringify(candidates)
  ].join("\n");
}

function batchJsonSchema(maximumOffers: number): Record<string, unknown> {
  const string = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["offers"],
    properties: {
      offers: {
        type: "array",
        maxItems: maximumOffers,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "itineraryKey",
            "priceAmount",
            "currency",
            "fareBasis",
            "cabin",
            "slices",
            "primaryAirlineCode",
            "participatingAirlineCodes",
            "evidence"
          ],
          properties: {
            itineraryKey: string,
            priceAmount: string,
            currency: string,
            fareBasis: { type: "string", enum: ["one_adult_total"] },
            cabin: {
              type: "string",
              enum: ["economy", "premium_economy", "business", "first"]
            },
            slices: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["origin", "destination", "departureDate", "segments"],
                properties: {
                  origin: string,
                  destination: string,
                  departureDate: string,
                  segments: {
                    type: "array",
                    minItems: 1,
                    maxItems: 6,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "origin",
                        "destination",
                        "departure",
                        "arrival",
                        "marketingAirlineCode",
                        "marketingAirline",
                        "flightNumber"
                      ],
                      properties: {
                        origin: string,
                        destination: string,
                        departure: string,
                        arrival: string,
                        marketingAirlineCode: string,
                        marketingAirline: string,
                        flightNumber: string
                      }
                    }
                  }
                }
              }
            },
            primaryAirlineCode: string,
            participatingAirlineCodes: { type: "array", items: string },
            evidence: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["url", "title", "domain"],
                properties: { url: string, title: string, domain: string }
              }
            }
          }
        }
      }
    }
  };
}
