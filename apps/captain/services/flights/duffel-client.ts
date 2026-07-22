import { z } from "zod";

import { FlightProviderError } from "./provider.js";
import type {
  FlightOffer,
  FlightRoute,
  FlightSearchRequest,
  FlightSearchResult
} from "./types.js";

const carrierSchema = z.object({
  name: z.string().default("Unknown"),
  iata_code: z.string().nullish()
});
const placeSchema = z.object({ iata_code: z.string().default("") });
const segmentSchema = z.object({
  origin: placeSchema,
  destination: placeSchema,
  departing_at: z.string().default(""),
  arriving_at: z.string().default(""),
  duration: z.string().optional(),
  marketing_carrier: carrierSchema,
  marketing_carrier_flight_number: z.string().default(""),
  passengers: z.array(z.object({ cabin_class: z.string().optional() })).default([])
});
const sliceSchema = z.object({
  duration: z.string().optional(),
  segments: z.array(segmentSchema).default([])
});
const conditionSchema = z.object({
  allowed: z.boolean().nullish(),
  penalty_amount: z.string().nullish(),
  penalty_currency: z.string().nullish()
}).nullish();
const offerSchema = z.object({
  id: z.string(),
  total_amount: z.coerce.number().nonnegative(),
  total_currency: z.string().length(3),
  owner: carrierSchema,
  slices: z.array(sliceSchema).min(1),
  conditions: z.object({
    change_before_departure: conditionSchema,
    refund_before_departure: conditionSchema
  }).optional()
});
const responseSchema = z.object({
  data: z.object({ id: z.string(), offers: z.array(z.unknown()).default([]) })
});
const errorSchema = z.object({
  errors: z.array(z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    title: z.string().optional()
  })).default([])
});

export function buildDuffelSearchPayload(input: FlightSearchRequest): Record<string, unknown> {
  if (input.infants > input.adults) {
    throw new FlightProviderError("invalid_request", "Each infant must travel with an adult");
  }
  return {
    slices: searchSlices(input).map((slice) => ({
      origin: slice.origin,
      destination: slice.destination,
      departure_date: slice.departureDate
    })),
    passengers: [
      ...Array.from({ length: input.adults }, () => ({ type: "adult" })),
      ...input.childrenAges.map((age) => ({ age })),
      ...Array.from({ length: input.infants }, () => ({ type: "infant_without_seat" }))
    ],
    cabin_class: input.cabin,
    max_connections: input.maxStops
  };
}

export class DuffelClient {
  readonly provider = "duffel" as const;
  readonly #accessToken: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #supplierTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: {
    accessToken: string;
    baseUrl?: string;
    timeoutMs?: number;
    supplierTimeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    this.#accessToken = options.accessToken;
    this.#baseUrl = (options.baseUrl ?? "https://api.duffel.com").replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#supplierTimeoutMs = options.supplierTimeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(input: FlightSearchRequest, signal?: AbortSignal): Promise<FlightSearchResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const query = new URLSearchParams({
      return_offers: "true",
      supplier_timeout: String(this.#supplierTimeoutMs),
      view: "offers"
    });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/air/offer_requests?${query}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          authorization: `Bearer ${this.#accessToken}`,
          "content-type": "application/json",
          "duffel-version": "v2"
        },
        body: JSON.stringify({ data: buildDuffelSearchPayload(input) }),
        signal: combined
      });
    } catch (error) {
      if (error instanceof FlightProviderError) throw error;
      if (combined.aborted) throw new FlightProviderError("timeout");
      throw new FlightProviderError("provider_unavailable");
    }
    if (!response.ok) throw await parseDuffelError(response);

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new FlightProviderError("invalid_response");
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new FlightProviderError("invalid_response");
    const offers = parsed.data.data.offers.map((item) => {
      const offer = offerSchema.safeParse(item);
      if (!offer.success) throw new FlightProviderError("invalid_response");
      return mapOffer(offer.data, item);
    });
    offers.sort(input.sort === "duration"
      ? (a, b) => a.durationSeconds - b.durationSeconds || a.price - b.price
      : (a, b) => a.price - b.price || a.durationSeconds - b.durationSeconds);
    return {
      provider: "duffel",
      searchId: parsed.data.data.id,
      totalResults: offers.length,
      offers: offers.slice(0, input.limit),
      searchedAt: new Date().toISOString()
    };
  }
}

async function parseDuffelError(response: Response): Promise<FlightProviderError> {
  let detail: string | undefined;
  try {
    const parsed = errorSchema.safeParse(await response.json());
    const first = parsed.success ? parsed.data.errors[0] : undefined;
    detail = first?.message ?? first?.title ?? first?.code;
  } catch {
    // Status still provides a stable category.
  }
  const retryAfterMs = parseRetryDelay(response.headers, Date.now());
  if (response.status === 401 || response.status === 403) {
    return new FlightProviderError("unauthorized", detail);
  }
  if ([400, 404, 422].includes(response.status)) {
    return new FlightProviderError("invalid_request", detail);
  }
  if (response.status === 429) {
    return new FlightProviderError("rate_limited", detail, retryAfterMs);
  }
  if (response.status === 504) return new FlightProviderError("timeout", detail);
  return new FlightProviderError("provider_unavailable", detail);
}

export function parseRetryDelay(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > nowMs) return date - nowMs;
  }

  const reset = Number(headers.get("ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  // Duffel documents ratelimit-reset as seconds until the bucket resets. Also
  // accept epoch seconds so test proxies and future provider changes are safe.
  return reset > 10_000_000_000
    ? Math.max(0, reset - nowMs)
    : reset > 1_000_000_000
      ? Math.max(0, reset * 1_000 - nowMs)
      : reset * 1_000;
}

function mapOffer(offer: z.infer<typeof offerSchema>, rawOffer: unknown): FlightOffer {
  const routes = offer.slices.map(mapRoute);
  const outbound = routes[0]!;
  const conditions = flattenConditions(offer.conditions);
  return {
    id: offer.id,
    price: offer.total_amount,
    currency: offer.total_currency.toUpperCase(),
    airlines: [...new Set(routes.flatMap((route) => route.segments.map((segment) => segment.airline)))],
    ownerAirline: carrierName(offer.owner),
    ownerAirlineCode: offer.owner.iata_code?.toUpperCase() ?? "",
    route: outbound.route,
    durationSeconds: routes.reduce((sum, route) => sum + route.durationSeconds, 0),
    stops: routes.reduce((sum, route) => sum + route.stops, 0),
    routes,
    outbound,
    ...(routes[1] ? { inbound: routes[1] } : {}),
    conditions,
    rawOffer
  };
}

function searchSlices(input: FlightSearchRequest) {
  if (input.slices?.length) return input.slices;
  return [
    { origin: input.origin, destination: input.destination, departureDate: input.departureDate },
    ...(input.returnDate
      ? [{ origin: input.destination, destination: input.origin, departureDate: input.returnDate }]
      : [])
  ];
}

function mapRoute(slice: z.infer<typeof sliceSchema>): FlightRoute {
  const segments = slice.segments.map((segment) => {
    const code = segment.marketing_carrier.iata_code?.toUpperCase() ?? "";
    return {
      airline: carrierName(segment.marketing_carrier),
      airlineCode: code,
      flightNumber: `${code}${segment.marketing_carrier_flight_number}`,
      origin: segment.origin.iata_code,
      destination: segment.destination.iata_code,
      departure: segment.departing_at,
      arrival: segment.arriving_at,
      durationSeconds: parseIsoDuration(segment.duration) || durationBetween(segment.departing_at, segment.arriving_at),
      ...(segment.passengers[0]?.cabin_class ? { cabin: segment.passengers[0].cabin_class } : {})
    };
  });
  const durationSeconds = parseIsoDuration(slice.duration) ||
    durationBetween(segments[0]?.departure, segments.at(-1)?.arrival) ||
    segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  return {
    segments,
    durationSeconds,
    stops: Math.max(0, segments.length - 1),
    route: segments.length === 0
      ? ""
      : [segments[0]!.origin, ...segments.map((segment) => segment.destination)].join(" → ")
  };
}

function carrierName(carrier: z.infer<typeof carrierSchema>): string {
  return carrier.name || carrier.iata_code || "Unknown";
}

function durationBetween(departure?: string, arrival?: string): number {
  if (!departure || !arrival) return 0;
  const start = Date.parse(departure);
  const end = Date.parse(arrival);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 1_000)
    : 0;
}

export function parseIsoDuration(value?: string): number {
  if (!value) return 0;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return 0;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Math.round(Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds));
}

function flattenConditions(
  conditions: z.infer<typeof offerSchema>["conditions"]
): Record<string, string> {
  const flattened: Record<string, string> = {};
  if (!conditions) return flattened;
  for (const [name, value] of Object.entries(conditions)) {
    if (!value) continue;
    if (value.allowed != null) flattened[`${name}.allowed`] = String(value.allowed);
    if (value.penalty_amount) {
      flattened[`${name}.penalty`] = [value.penalty_amount, value.penalty_currency].filter(Boolean).join(" ");
    }
  }
  return flattened;
}
