import { createHash } from "node:crypto";

import {
  airportCodeMatches,
  deriveOfferMetrics,
  expandSearchDateCombinations,
  FlightSearchProviderError,
  SearchWindowCombinationError,
  verifiedOfferCandidateSchema,
  type FlightSearchProvider,
  type FlightSearchResult,
  type SearchSpecRequest,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import { z } from "zod";

import { convertAmount, isSupportedFxCurrency, type FxQuote, type SupportedFxCurrency } from "./fx.js";

const carrierSchema = z.object({ name: z.string().default("Unknown"), iata_code: z.string().nullish() });
const placeSchema = z.object({ iata_code: z.string().default("") });
const segmentSchema = z.object({
  origin: placeSchema,
  destination: placeSchema,
  departing_at: z.string(),
  arriving_at: z.string(),
  marketing_carrier: carrierSchema,
  marketing_carrier_flight_number: z.string().default(""),
  passengers: z.array(z.object({ cabin_class: z.string().optional() })).default([])
});
const sliceSchema = z.object({ segments: z.array(segmentSchema).default([]) });
const offerSchema = z.object({
  id: z.string(),
  expires_at: z.string().datetime().nullish(),
  total_amount: z.coerce.number().nonnegative(),
  total_currency: z.string().length(3),
  owner: carrierSchema,
  slices: z.array(sliceSchema).min(1)
});
const offerRequestResponseSchema = z.object({
  data: z.object({ id: z.string() })
});
const offerListResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
  meta: z.object({
    after: z.string().nullable().optional()
  }).default({})
});
const errorSchema = z.object({
  errors: z.array(z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    title: z.string().optional()
  })).default([])
});

const DATE_SEARCH_CONCURRENCY = 3;

export type DuffelErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "offer_expired"
  | "fx_unavailable";

export class DuffelError extends FlightSearchProviderError {
  constructor(
    readonly code: DuffelErrorCode,
    message?: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(
      "official_duffel",
      code,
      message ?? `Duffel request failed: ${code}`,
      retryAfterMs
    );
    this.name = "DuffelError";
  }
}

export class DuffelFlightSearchProvider implements FlightSearchProvider {
  readonly provider = "official_duffel" as const;
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #supplierTimeoutMs: number;

  constructor(options: {
    accessToken: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    supplierTimeoutMs?: number;
  }) {
    this.#token = options.accessToken.trim();
    if (!this.#token) throw new Error("DUFFEL_ACCESS_TOKEN is required");
    this.#baseUrl = (options.baseUrl ?? "https://api.duffel.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#supplierTimeoutMs = options.supplierTimeoutMs ?? 60_000;
    if (this.#supplierTimeoutMs < 2_000 || this.#supplierTimeoutMs > 60_000) {
      throw new Error("Duffel supplierTimeoutMs must be between 2,000 and 60,000");
    }
  }

  async search(request: SearchSpecRequest): Promise<FlightSearchResult> {
    if (!isSupportedFxCurrency(request.currency)) {
      throw new DuffelError(
        "invalid_request",
        `Duffel inventory currently supports USD and GBP trips only (got ${request.currency})`
      );
    }
    let exactRequests: SearchSpecRequest[];
    try {
      exactRequests = expandSearchDateCombinations(request);
    } catch (error) {
      if (error instanceof SearchWindowCombinationError) {
        throw new DuffelError("invalid_request", error.message);
      }
      throw error;
    }
    const results = await mapBounded(
      exactRequests,
      DATE_SEARCH_CONCURRENCY,
      (exactRequest) => this.#searchExact(exactRequest)
    );
    const requestIds = results.map((result) => result.requestId);
    const batchId = requestIds.length === 1
      ? requestIds[0]!
      : createHash("sha256").update(requestIds.join("|")).digest("hex");
    const offers = results.flatMap((result) => result.offers)
      .sort((left, right) => Number(left.priceAmount) - Number(right.priceAmount));
    return {
      provider: this.provider,
      requestId: batchId,
      discoveryResponseId: batchId,
      verificationResponseId: batchId,
      model: "duffel",
      promptVersion: "duffel-exhaustive-window-v3",
      offers,
      rejectionCounts: {}
    };
  }

  async #searchExact(request: SearchSpecRequest): Promise<FlightSearchResult> {
    const response = await this.#request(
      `/air/offer_requests?return_offers=false&supplier_timeout=${this.#supplierTimeoutMs}&view=offers`,
      {
        method: "POST",
        body: JSON.stringify({ data: toOfferRequest(request) })
      }
    );
    const parsed = offerRequestResponseSchema.safeParse(response);
    if (!parsed.success) throw new DuffelError("invalid_response");
    const rawOffers = await this.#listOffers(parsed.data.data.id);

    const offers: VerifiedOfferCandidate[] = [];
    for (const raw of rawOffers) {
      try {
        const mapped = await mapOffer(raw, request, this.#fetch);
        if (mapped) offers.push(mapped);
      } catch (error) {
        if (error instanceof DuffelError && error.code === "fx_unavailable") throw error;
        // Skip malformed individual offers.
      }
    }
    offers.sort((left, right) => Number(left.priceAmount) - Number(right.priceAmount));

    return {
      provider: this.provider,
      requestId: parsed.data.data.id,
      discoveryResponseId: parsed.data.data.id,
      verificationResponseId: parsed.data.data.id,
      model: "duffel",
      promptVersion: "duffel-paginated-v2",
      offers,
      rejectionCounts: {}
    };
  }

  async #listOffers(offerRequestId: string): Promise<unknown[]> {
    const offers: unknown[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    do {
      const query = new URLSearchParams({
        offer_request_id: offerRequestId,
        limit: "200",
        sort: "total_amount"
      });
      if (after) query.set("after", after);
      const response = await this.#request(`/air/offers?${query.toString()}`, { method: "GET" });
      const parsed = offerListResponseSchema.safeParse(response);
      if (!parsed.success) throw new DuffelError("invalid_response");
      offers.push(...parsed.data.data);
      const next = parsed.data.meta.after ?? null;
      if (next && seenCursors.has(next)) {
        throw new DuffelError("invalid_response", "Duffel repeated an offer pagination cursor");
      }
      if (next) seenCursors.add(next);
      after = next;
    } while (after);
    return offers;
  }

  async #request(path: string, options: { method: "GET" | "POST"; body?: string }): Promise<unknown> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          authorization: `Bearer ${this.#token}`,
          "duffel-version": "v2",
          ...(options.body ? { "content-type": "application/json" } : {})
        },
        ...(options.body ? { body: options.body } : {}),
        signal
      });
    } catch {
      if (signal.aborted) throw new DuffelError("timeout");
      throw new DuffelError("unavailable");
    }
    if (!response.ok) throw await parseError(response);
    try {
      return await response.json();
    } catch {
      throw new DuffelError("invalid_response");
    }
  }
}

async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!);
      }
    }
  ));
  return results;
}

function toOfferRequest(request: SearchSpecRequest): Record<string, unknown> {
  return {
    slices: expectedSlices(request).map((slice) => ({
      origin: pickPlace(slice.originAirports),
      destination: pickPlace(slice.destinationAirports),
      departure_date: slice.departureStart
    })),
    passengers: [
      ...Array.from({ length: request.passenger.adults }, () => ({ type: "adult" })),
      ...request.passenger.childrenAges.map((age) => ({ age })),
      ...Array.from({ length: request.passenger.infants }, () => ({ type: "infant_without_seat" }))
    ],
    cabin_class: request.cabin,
    max_connections: request.maxConnections
  };
}

function pickPlace(airports: string[]): string {
  const code = airports[0]?.trim().toUpperCase();
  if (!code) throw new DuffelError("invalid_request", "Search slice is missing an airport");
  return code;
}

async function mapOffer(
  raw: unknown,
  request: SearchSpecRequest,
  fetchImpl: typeof fetch
): Promise<VerifiedOfferCandidate | null> {
  const parsed = offerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const expectedRequestSlices = expectedSlices(request);
  if (parsed.data.slices.length !== expectedRequestSlices.length) return null;

  const slices = [];
  for (let index = 0; index < parsed.data.slices.length; index += 1) {
    const slice = parsed.data.slices[index]!;
    const expected = expectedRequestSlices[index]!;
    if (slice.segments.length === 0) return null;
    if (slice.segments.length - 1 > request.maxConnections) return null;
    const origin = slice.segments[0]!.origin.iata_code.toUpperCase();
    const destination = slice.segments.at(-1)!.destination.iata_code.toUpperCase();
    if (!airportCodeMatches(expected.originAirports, origin)) return null;
    if (!airportCodeMatches(expected.destinationAirports, destination)) return null;
    const departureDate = slice.segments[0]!.departing_at.slice(0, 10);
    if (departureDate < expected.departureStart || departureDate > expected.departureEnd) return null;
    const arrivalDate = slice.segments.at(-1)!.arriving_at.slice(0, 10);
    if (expected.arriveBy && arrivalDate > expected.arriveBy) return null;
    slices.push({
      origin,
      destination,
      departureDate,
      segments: slice.segments.map((segment) => {
        const airlineCode = (segment.marketing_carrier.iata_code ?? "XX").toUpperCase();
        return {
          origin: segment.origin.iata_code.toUpperCase(),
          destination: segment.destination.iata_code.toUpperCase(),
          departure: ensureOffset(segment.departing_at),
          arrival: ensureOffset(segment.arriving_at),
          marketingAirlineCode: airlineCode,
          marketingAirline: segment.marketing_carrier.name,
          flightNumber: `${airlineCode}${segment.marketing_carrier_flight_number}`
        };
      })
    });
  }

  const sourceCurrency = parsed.data.total_currency.toUpperCase();
  if (!isSupportedFxCurrency(sourceCurrency)) return null;
  let priceAmount = parsed.data.total_amount;
  let currency: SupportedFxCurrency = sourceCurrency;
  let quote: FxQuote | null = null;
  if (sourceCurrency !== request.currency.toUpperCase()) {
    try {
      const converted = await convertAmount(priceAmount, sourceCurrency, request.currency, { fetch: fetchImpl });
      priceAmount = converted.amount;
      const targetCurrency = request.currency.toUpperCase();
      if (!isSupportedFxCurrency(targetCurrency)) return null;
      currency = targetCurrency;
      quote = converted.quote;
    } catch (error) {
      throw new DuffelError(
        "fx_unavailable",
        error instanceof Error ? error.message : "Currency conversion failed"
      );
    }
  }

  const participating = [...new Set(
    slices.flatMap((slice) => slice.segments.map((segment) => segment.marketingAirlineCode))
  )].sort();
  const primary = (
    slices[0]?.segments[0]?.marketingAirlineCode
    ?? parsed.data.owner.iata_code
    ?? participating[0]
    ?? "XX"
  ).toUpperCase();
  const itineraryKey = createHash("sha256")
    .update(JSON.stringify({ slices, primaryAirlineCode: primary }))
    .digest("hex");

  const candidate = verifiedOfferCandidateSchema.parse({
    itineraryKey,
    providerOfferId: parsed.data.id,
    expiresAt: parsed.data.expires_at ?? null,
    priceAmount: formatAmount(priceAmount, currency),
    currency,
    fareBasis: "one_adult_total",
    cabin: request.cabin,
    slices,
    primaryAirlineCode: primary,
    participatingAirlineCodes: participating.includes(primary) ? participating : [primary, ...participating],
    evidence: [{
      url: `https://duffel.com/air/offers/${encodeURIComponent(parsed.data.id)}`,
      title: quote
        ? `Duffel ${sourceCurrency} ${parsed.data.total_amount} → ${currency} @ ${quote.rate} (${quote.asOf})`
        : `Duffel offer ${parsed.data.id}`,
      domain: "duffel.com"
    }]
  });

  // Touch metrics so unused import stays meaningful for callers that re-derive.
  void deriveOfferMetrics(candidate.slices);
  void quote;
  return candidate;
}

function expectedSlices(request: SearchSpecRequest): SearchSpecRequest["slices"] {
  if (request.tripType !== "round_trip") return request.slices;
  const outbound = request.slices[0];
  if (!outbound || !request.stayNights) return request.slices;
  const returnDate = addIsoDays(outbound.departureStart, request.stayNights.preferred);
  return [
    outbound,
    {
      originAirports: outbound.destinationAirports,
      destinationAirports: outbound.originAirports,
      departureStart: returnDate,
      departureEnd: returnDate
    }
  ];
}

function addIsoDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function ensureOffset(value: string): string {
  if (/[zZ]|[+-]\d{2}:\d{2}$/u.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return `${value}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)) return `${value}Z`;
  return value;
}

function formatAmount(value: number, _currency: string): string {
  void _currency;
  return value.toFixed(2);
}

async function parseError(response: Response): Promise<DuffelError> {
  let detail: string | undefined;
  let providerCode: string | undefined;
  try {
    const parsed = errorSchema.safeParse(await response.json());
    const first = parsed.success ? parsed.data.errors[0] : undefined;
    providerCode = first?.code;
    detail = first?.message ?? first?.title ?? providerCode;
  } catch {
    // HTTP status is enough to classify.
  }
  if (providerCode === "offer_no_longer_available" || providerCode === "offer_expired") {
    return new DuffelError("offer_expired", detail);
  }
  if (response.status === 401 || response.status === 403) return new DuffelError("unauthorized", detail);
  if ([400, 404, 422].includes(response.status)) return new DuffelError("invalid_request", detail);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new DuffelError(
      "rate_limited",
      detail,
      Number.isFinite(retryAfter) ? retryAfter * 1_000 : null
    );
  }
  if (response.status === 504) return new DuffelError("timeout", detail);
  return new DuffelError("unavailable", detail);
}
