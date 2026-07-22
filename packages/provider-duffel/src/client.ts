import type { SearchSpecRequest } from "@agents/flight-domain";
import { z } from "zod";

const carrierSchema = z.object({ name: z.string().default("Unknown"), iata_code: z.string().nullish() });
const placeSchema = z.object({ iata_code: z.string().default("") });
const segmentSchema = z.object({
  origin: placeSchema,
  destination: placeSchema,
  departing_at: z.string(),
  arriving_at: z.string(),
  duration: z.string().optional(),
  marketing_carrier: carrierSchema,
  marketing_carrier_flight_number: z.string().default(""),
  passengers: z.array(z.object({ cabin_class: z.string().optional() })).default([])
});
const sliceSchema = z.object({ duration: z.string().optional(), segments: z.array(segmentSchema).default([]) });
const conditionSchema = z.object({
  allowed: z.boolean().nullish(),
  penalty_amount: z.string().nullish(),
  penalty_currency: z.string().nullish()
}).nullish();
const offerSchema = z.object({
  id: z.string(),
  expires_at: z.string().datetime().nullish(),
  total_amount: z.coerce.number().nonnegative(),
  total_currency: z.string().length(3),
  owner: carrierSchema,
  slices: z.array(sliceSchema).min(1),
  conditions: z.object({
    change_before_departure: conditionSchema,
    refund_before_departure: conditionSchema
  }).optional()
});
const searchResponseSchema = z.object({ data: z.object({ id: z.string(), offers: z.array(z.unknown()).default([]) }) });
const offerResponseSchema = z.object({ data: z.unknown() });
const errorSchema = z.object({
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional(), title: z.string().optional() })).default([])
});

export type DuffelSegment = {
  airlineCode: string;
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
};

export type DuffelOffer = {
  id: string;
  searchId: string;
  price: number;
  currency: string;
  expiresAt: string | null;
  itineraryKey: string;
  segments: DuffelSegment[];
  conditions: Record<string, string>;
  raw: Record<string, unknown>;
};

export type DuffelSearchResult = {
  searchId: string;
  searchedAt: string;
  offers: DuffelOffer[];
};

export type DuffelErrorCode = "unauthorized" | "invalid_request" | "rate_limited" | "timeout" | "unavailable" | "invalid_response" | "offer_expired";

export class DuffelError extends Error {
  constructor(readonly code: DuffelErrorCode, message?: string, readonly retryAfterMs?: number) {
    super(message ?? `Duffel request failed: ${code}`);
    this.name = "DuffelError";
  }
}

export class DuffelClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #supplierTimeoutMs: number;

  constructor(options: { accessToken: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; supplierTimeoutMs?: number }) {
    this.#token = options.accessToken;
    this.#baseUrl = (options.baseUrl ?? "https://api.duffel.com").replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#supplierTimeoutMs = options.supplierTimeoutMs ?? 20_000;
  }

  async search(request: SearchSpecRequest, signal?: AbortSignal): Promise<DuffelSearchResult> {
    const response = await this.#request(
      `/air/offer_requests?return_offers=true&supplier_timeout=${this.#supplierTimeoutMs}&view=offers`,
      {
        method: "POST",
        body: JSON.stringify({ data: toOfferRequest(request) }),
        ...(signal ? { signal } : {})
      }
    );
    const parsed = searchResponseSchema.safeParse(response);
    if (!parsed.success) throw new DuffelError("invalid_response");
    const searchedAt = new Date().toISOString();
    return {
      searchId: parsed.data.data.id,
      searchedAt,
      offers: parsed.data.data.offers.map((raw) => parseOffer(raw, parsed.data.data.id))
    };
  }

  async refreshOffer(offerId: string, signal?: AbortSignal): Promise<DuffelOffer> {
    const response = await this.#request(`/air/offers/${encodeURIComponent(offerId)}?return_available_services=true`, {
      method: "GET",
      ...(signal ? { signal } : {})
    });
    const wrapped = offerResponseSchema.safeParse(response);
    if (!wrapped.success) throw new DuffelError("invalid_response");
    return parseOffer(wrapped.data.data, "refresh");
  }

  async #request(path: string, options: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
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

function toOfferRequest(request: SearchSpecRequest): Record<string, unknown> {
  return {
    slices: request.slices.map((slice) => ({
      origin: slice.origin,
      destination: slice.destination,
      departure_date: slice.departureDate
    })),
    passengers: request.passengers,
    cabin_class: request.cabin,
    max_connections: request.maxConnections
  };
}

function parseOffer(raw: unknown, searchId: string): DuffelOffer {
  const parsed = offerSchema.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new DuffelError("invalid_response");
  const segments = parsed.data.slices.flatMap((slice) => slice.segments.map((segment) => {
    const airlineCode = segment.marketing_carrier.iata_code?.toUpperCase() ?? "";
    return {
      airlineCode,
      airline: segment.marketing_carrier.name,
      flightNumber: `${airlineCode}${segment.marketing_carrier_flight_number}`,
      origin: segment.origin.iata_code.toUpperCase(),
      destination: segment.destination.iata_code.toUpperCase(),
      departure: segment.departing_at,
      arrival: segment.arriving_at
    };
  }));
  return {
    id: parsed.data.id,
    searchId,
    price: parsed.data.total_amount,
    currency: parsed.data.total_currency.toUpperCase(),
    expiresAt: parsed.data.expires_at ?? null,
    itineraryKey: segments.map((segment) => [segment.flightNumber, segment.origin, segment.destination, canonicalTime(segment.departure), canonicalTime(segment.arrival)].join("|")).join("||"),
    segments,
    conditions: flattenConditions(parsed.data.conditions),
    raw: raw as Record<string, unknown>
  };
}

function canonicalTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function flattenConditions(conditions: z.infer<typeof offerSchema>["conditions"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!conditions) return result;
  for (const [name, value] of Object.entries(conditions)) {
    if (!value) continue;
    if (value.allowed != null) result[`${name}.allowed`] = String(value.allowed);
    if (value.penalty_amount) result[`${name}.penalty`] = [value.penalty_amount, value.penalty_currency].filter(Boolean).join(" ");
  }
  return result;
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
    // HTTP status remains sufficient for a stable category.
  }
  if (providerCode === "offer_expired") return new DuffelError("offer_expired", detail);
  if (response.status === 401 || response.status === 403) return new DuffelError("unauthorized", detail);
  if ([400, 404, 422].includes(response.status)) return new DuffelError("invalid_request", detail);
  if (response.status === 429) return new DuffelError("rate_limited", detail, retryDelay(response.headers));
  if (response.status === 504) return new DuffelError("timeout", detail);
  return new DuffelError("unavailable", detail);
}

function retryDelay(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}
