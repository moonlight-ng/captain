import { createHash, randomUUID } from "node:crypto";

import {
  airportCodeMatches,
  expandSearchDateCombinations,
  FlightSearchProviderError,
  SearchWindowCombinationError,
  verifiedOfferCandidateSchema,
  type FlightSearchProvider,
  type FlightSearchResult,
  type SearchSlice,
  type SearchSpecRequest,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import {
  convertAmount,
  isSupportedFxCurrency,
  type FxQuote
} from "@agents/provider-duffel";
import { z } from "zod";

const DEFAULT_MCP_URL = "https://mcp.flysoar.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_OFFER_LIMIT = 60;
const DATE_SEARCH_CONCURRENCY = 3;

const mcpContentSchema = z.object({
  type: z.string(),
  text: z.string().optional()
}).passthrough();

const mcpEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  error: z.object({
    code: z.number(),
    message: z.string()
  }).passthrough().optional(),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z.array(mcpContentSchema).default([])
  }).passthrough().optional()
}).passthrough();

const soarSegmentSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  departure: z.string(),
  arrival: z.string(),
  carrier_iata: z.string().nullish(),
  carrier_name: z.string().nullish(),
  flight_number: z.string().default("")
}).passthrough();

const soarSliceSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  departure: z.string(),
  arrival: z.string(),
  segments: z.array(soarSegmentSchema).min(1)
}).passthrough();

const soarOfferSchema = z.object({
  id: z.string().min(1),
  total_amount: z.string(),
  total_currency: z.string(),
  bookable: z.boolean().default(true),
  slices: z.array(soarSliceSchema).min(1),
  expires_at: z.string().nullish()
}).passthrough();

const soarSearchResultSchema = z.object({
  offers: z.array(soarOfferSchema).default([]),
  result_count: z.number().int().nonnegative().default(0),
  price_currency: z.string().default("USD"),
  error: z.string().optional(),
  code: z.string().optional()
}).passthrough();

export type FlysoarProviderErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "fx_unavailable";

export class FlysoarProviderError extends FlightSearchProviderError {
  constructor(
    code: FlysoarProviderErrorCode,
    message?: string,
    retryAfterMs: number | null = null
  ) {
    super(
      "flysoar_mcp",
      code,
      message ?? `Flysoar MCP request failed: ${code}`,
      retryAfterMs
    );
    this.name = "FlysoarProviderError";
  }
}

export class FlysoarMcpFlightSearchProvider implements FlightSearchProvider {
  readonly provider = "flysoar_mcp" as const;
  readonly #mcpUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #offerLimit: number;

  constructor(options: {
    mcpUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    offerLimit?: number;
  } = {}) {
    this.#mcpUrl = (options.mcpUrl?.trim() || DEFAULT_MCP_URL).replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    this.#offerLimit = options.offerLimit ?? DEFAULT_OFFER_LIMIT;
    if (!Number.isSafeInteger(this.#offerLimit) || this.#offerLimit < 1 || this.#offerLimit > 200) {
      throw new Error("Flysoar offerLimit must be between 1 and 200");
    }
  }

  async search(request: SearchSpecRequest): Promise<FlightSearchResult> {
    if (!isSupportedFxCurrency(request.currency)) {
      throw new FlysoarProviderError(
        "invalid_request",
        `Flysoar backup currently supports USD and GBP trips only (got ${request.currency})`
      );
    }
    let exactRequests: SearchSpecRequest[];
    try {
      exactRequests = expandSearchDateCombinations(request);
    } catch (error) {
      if (error instanceof SearchWindowCombinationError) {
        throw new FlysoarProviderError("invalid_request", error.message);
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
      model: "flysoar-mcp",
      promptVersion: "soar-search-flights-exhaustive-window-v2",
      offers,
      rejectionCounts: results.reduce<Partial<Record<string, number>>>((counts, result) => {
        for (const [key, value] of Object.entries(result.rejectionCounts)) {
          counts[key] = (counts[key] ?? 0) + (value ?? 0);
        }
        return counts;
      }, {})
    };
  }

  async #searchExact(request: SearchSpecRequest): Promise<FlightSearchResult> {
    const mcpId = randomUUID();
    const response = await this.#request({
      jsonrpc: "2.0",
      id: mcpId,
      method: "tools/call",
      params: {
        name: "soar_search_flights",
        arguments: toSearchArguments(request, this.#offerLimit)
      }
    });
    const requestId = response.headers.get("x-request-id")?.trim() || mcpId;
    const envelope = mcpEnvelopeSchema.safeParse(await safeJson(response));
    if (!envelope.success) {
      throw new FlysoarProviderError("invalid_response", "Flysoar returned an invalid MCP envelope");
    }
    if (envelope.data.error) {
      throw new FlysoarProviderError(
        "invalid_response",
        `Flysoar MCP error ${envelope.data.error.code}: ${envelope.data.error.message}`
      );
    }
    if (!envelope.data.result) {
      throw new FlysoarProviderError("invalid_response", "Flysoar MCP response omitted its result");
    }
    const payload = parseToolPayload(envelope.data.result);
    if (payload.error || envelope.data.result.isError) {
      throw payloadError(payload);
    }

    let quote: FxQuote;
    try {
      quote = (await convertAmount(1, "USD", request.currency, {
        fetch: this.#fetch
      })).quote;
    } catch (error) {
      throw new FlysoarProviderError(
        "fx_unavailable",
        error instanceof Error ? error.message : "Flysoar currency conversion failed"
      );
    }
    const offers: VerifiedOfferCandidate[] = [];
    let invalidOffers = 0;
    for (const offer of payload.offers) {
      try {
        const mapped = mapOffer(offer, request, quote);
        if (mapped) offers.push(mapped);
        else invalidOffers += 1;
      } catch {
        invalidOffers += 1;
      }
    }
    offers.sort((left, right) => Number(left.priceAmount) - Number(right.priceAmount));
    return {
      provider: this.provider,
      requestId,
      discoveryResponseId: requestId,
      verificationResponseId: requestId,
      model: "flysoar-mcp",
      promptVersion: "soar-search-flights-v1",
      offers,
      rejectionCounts: invalidOffers > 0 ? { invalid_offer: invalidOffers } : {}
    };
  }

  async #request(body: Record<string, unknown>): Promise<Response> {
    let response: Response;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      response = await this.#fetch(this.#mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION
        },
        body: JSON.stringify(body),
        signal
      });
    } catch {
      if (signal.aborted) throw new FlysoarProviderError("timeout");
      throw new FlysoarProviderError("unavailable");
    }
    if (response.ok) return response;
    const retryHeader = response.headers.get("retry-after");
    const retryAfter = retryHeader ? Number(retryHeader) : Number.NaN;
    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : null;
    if (response.status === 401 || response.status === 403) {
      throw new FlysoarProviderError("unauthorized", "Flysoar rejected the request");
    }
    if (response.status === 429) {
      throw new FlysoarProviderError("rate_limited", "Flysoar search rate limit reached", retryAfterMs);
    }
    throw new FlysoarProviderError(
      response.status >= 500 ? "unavailable" : "invalid_request",
      `Flysoar returned HTTP ${response.status}`,
      retryAfterMs
    );
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

function toSearchArguments(
  request: SearchSpecRequest,
  offerLimit: number
): Record<string, unknown> {
  const common = {
    passengers: request.passenger.adults,
    cabin: request.cabin,
    max_connections: request.maxConnections,
    currency: "USD",
    sort: "best",
    limit: offerLimit
  };
  if (request.tripType === "multi_city") {
    return {
      ...common,
      slices: request.slices.map((slice) => ({
        origin: requiredPlace(slice.originAirports),
        destination: requiredPlace(slice.destinationAirports),
        date: slice.departureStart,
        cabin: request.cabin
      }))
    };
  }
  const first = request.slices[0];
  if (!first) throw new FlysoarProviderError("invalid_request", "Search is missing its first slice");
  return {
    ...common,
    origin: requiredPlace(first.originAirports),
    destination: requiredPlace(first.destinationAirports),
    date: first.departureStart,
    ...(request.tripType === "round_trip" && request.stayNights
      ? { return_date: addDays(first.departureStart, request.stayNights.preferred) }
      : {})
  };
}

function requiredPlace(airports: string[]): string {
  const place = airports[0]?.trim().toUpperCase();
  if (!place) throw new FlysoarProviderError("invalid_request", "Search slice is missing an airport");
  return place;
}

function parseToolPayload(
  result: z.infer<typeof mcpEnvelopeSchema>["result"] & {}
): z.infer<typeof soarSearchResultSchema> {
  let value = result.structuredContent;
  if (value === undefined) {
    const text = result.content.find((item) => item.type === "text" && item.text)?.text;
    if (!text) throw new FlysoarProviderError("invalid_response", "Flysoar tool returned no payload");
    try {
      value = JSON.parse(text);
    } catch {
      throw new FlysoarProviderError("invalid_response", "Flysoar tool returned invalid JSON");
    }
  }
  const parsed = soarSearchResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new FlysoarProviderError("invalid_response", "Flysoar tool payload did not match its schema");
  }
  return parsed.data;
}

function payloadError(payload: z.infer<typeof soarSearchResultSchema>): FlysoarProviderError {
  const normalized = payload.code?.toLowerCase() ?? "";
  const code: FlysoarProviderErrorCode = normalized.includes("rate")
    ? "rate_limited"
    : normalized.includes("auth")
      ? "unauthorized"
      : normalized.includes("invalid")
        ? "invalid_request"
        : "unavailable";
  return new FlysoarProviderError(code, payload.error ?? "Flysoar tool call failed");
}

function mapOffer(
  offer: z.infer<typeof soarOfferSchema>,
  request: SearchSpecRequest,
  quote: FxQuote
): VerifiedOfferCandidate | null {
  if (!offer.bookable) return null;
  const expected = expectedSlices(request);
  if (offer.slices.length !== expected.length) return null;
  const slices = [];
  for (let index = 0; index < offer.slices.length; index += 1) {
    const slice = offer.slices[index]!;
    const expectedSlice = expected[index]!;
    const origin = slice.origin.trim().toUpperCase();
    const destination = slice.destination.trim().toUpperCase();
    if (!placeMatches(expectedSlice.originAirports, origin)) return null;
    if (!placeMatches(expectedSlice.destinationAirports, destination)) return null;
    const departureDate = slice.departure.slice(0, 10);
    if (
      departureDate < expectedSlice.departureStart
      || departureDate > expectedSlice.departureEnd
    ) return null;
    if (slice.segments.length - 1 > request.maxConnections) return null;
    const segments = slice.segments.map((segment) => {
      const carrier = normalizedCarrier(segment.carrier_iata);
      return {
        origin: segment.origin.trim().toUpperCase(),
        destination: segment.destination.trim().toUpperCase(),
        departure: ensureOffset(segment.departure),
        arrival: ensureOffset(segment.arrival),
        marketingAirlineCode: carrier,
        marketingAirline: segment.carrier_name?.trim() || carrier,
        flightNumber: normalizedFlightNumber(carrier, segment.flight_number)
      };
    });
    if (expectedSlice.arriveBy && segments.at(-1)!.arrival.slice(0, 10) > expectedSlice.arriveBy) {
      return null;
    }
    if (
      segments[0]?.origin !== origin
      || segments.at(-1)?.destination !== destination
    ) return null;
    slices.push({ origin, destination, departureDate, segments });
  }

  const sourceCurrency = offer.total_currency.trim().toUpperCase();
  if (sourceCurrency !== "USD") return null;
  const sourceAmount = Number(offer.total_amount);
  if (!Number.isFinite(sourceAmount) || sourceAmount < 0) return null;
  const targetCurrency = request.currency.trim().toUpperCase();
  const convertedAmount = Math.round(sourceAmount * quote.rate * 100) / 100;
  if (request.maximumPrice !== null && convertedAmount > request.maximumPrice) return null;
  const participating = [...new Set(
    slices.flatMap((slice) => slice.segments.map((segment) => segment.marketingAirlineCode))
  )].sort();
  const primary = participating[0] ?? "XX";
  const itineraryKey = createHash("sha256")
    .update(JSON.stringify({
      slices,
      primaryAirlineCode: primary,
      passenger: request.passenger
    }))
    .digest("hex");
  return verifiedOfferCandidateSchema.parse({
    itineraryKey,
    providerOfferId: offer.id,
    expiresAt: normalizeExpiry(offer.expires_at),
    priceAmount: convertedAmount.toFixed(2),
    currency: targetCurrency,
    fareBasis: request.passenger.adults === 1 ? "one_adult_total" : "party_total",
    cabin: request.cabin,
    slices,
    primaryAirlineCode: primary,
    participatingAirlineCodes: participating,
    evidence: [{
      url: "https://flysoar.ai/mcp",
      title: sourceCurrency === targetCurrency
        ? `Flysoar offer ${offer.id}`
        : `Flysoar USD ${offer.total_amount} → ${targetCurrency} @ ${quote.rate} (${quote.asOf})`,
      domain: "flysoar.ai"
    }]
  });
}

function expectedSlices(request: SearchSpecRequest): SearchSlice[] {
  if (request.tripType !== "round_trip") return request.slices;
  const outbound = request.slices[0];
  if (!outbound || !request.stayNights) return request.slices;
  const returnDate = addDays(outbound.departureStart, request.stayNights.preferred);
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

function placeMatches(requested: string[], actual: string): boolean {
  return airportCodeMatches(requested, actual);
}

function normalizedCarrier(value: string | null | undefined): string {
  const carrier = value?.trim().toUpperCase();
  return carrier && /^[A-Z0-9]{2,3}$/u.test(carrier) ? carrier : "XX";
}

function normalizedFlightNumber(carrier: string, value: string): string {
  const number = value.trim().toUpperCase().replace(/\s+/gu, "");
  if (!number) return `${carrier}0`;
  return number.startsWith(carrier) ? number : `${carrier}${number}`;
}

function ensureOffset(value: string): string {
  if (/[zZ]|[+-]\d{2}:\d{2}$/u.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return `${value}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)) return `${value}Z`;
  return value;
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = ensureOffset(value);
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FlysoarProviderError("invalid_response", "Flysoar returned invalid JSON");
  }
}
