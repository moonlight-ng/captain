import {
  FlightSearchProviderError,
  buildSearchSpecs,
  deriveOfferMetrics,
  type FlightSearchProvider,
  type OfferSnapshot,
  type TripBrief,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { TripService } from "../trips/service.js";

const MAX_RETURNED_OFFERS = 8;
const STORED_OFFER_FRESHNESS_MS = 5 * 60_000;

export type FlightLookupInput = {
  tripId?: string | undefined;
  draftId?: string | undefined;
  airlineCode?: string | undefined;
};

export type FlightLookupOffer = {
  itineraryKey: string;
  priceAmount: string;
  currency: string;
  primaryAirlineCode: string;
  participatingAirlineCodes: string[];
  route: string;
  stops: number;
  durationMinutes: number;
  flightNumbers: string[];
  segments: Array<{
    airlineCode: string;
    airline: string;
    flightNumber: string;
    origin: string;
    destination: string;
    departure: string;
    arrival: string;
  }>;
  evidenceUrl: string | null;
  observedAt: string;
  expiresAt: string | null;
};

export type FlightLookupResult = {
  status: "found" | "no_matches" | "needs_confirmation" | "no_trip" | "unavailable";
  source: "stored_trip" | "live_trip" | "live_prepared_trip" | null;
  tripId: string | null;
  draftId: string | null;
  airlineCode: string | null;
  route: string | null;
  departureDate: string | null;
  storedOfferCount: number;
  matchingOfferCount: number;
  offers: FlightLookupOffer[];
  searchedAt: string | null;
  errorCode?: string;
};

export class FlightLookupService {
  readonly #store: CaptainPlatformStore;
  readonly #trips: TripService;
  readonly #provider: FlightSearchProvider | null;
  readonly #now: () => Date;

  constructor(options: {
    store: CaptainPlatformStore;
    trips: TripService;
    provider: FlightSearchProvider | null;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#trips = options.trips;
    this.#provider = options.provider;
    this.#now = options.now ?? (() => new Date());
  }

  async search(userId: string, input: FlightLookupInput): Promise<FlightLookupResult> {
    const airlineCode = input.airlineCode?.trim().toUpperCase() || null;
    const trip = input.tripId
      ? await this.#store.getTrip(userId, input.tripId)
      : await this.#store.getActiveTrip(userId);

    let brief: TripBrief;
    let tripId: string | null = null;
    let draftId: string | null = null;
    let liveSource: "live_trip" | "live_prepared_trip";
    let storedOfferCount = 0;

    if (trip && !["cancelled", "completed", "archived"].includes(trip.status)) {
      const stored = await this.#trips.offers(userId, trip.id);
      const matching = filterByAirline(stored, airlineCode);
      storedOfferCount = stored.length;
      if (matching.length > 0 && hasFreshOffers(matching, this.#now())) {
        return {
          status: "found",
          source: "stored_trip",
          tripId: trip.id,
          draftId: null,
          airlineCode,
          route: routeLabel(trip.brief),
          departureDate: trip.brief.departureWindow.start,
          storedOfferCount,
          matchingOfferCount: matching.length,
          offers: matching.slice(0, MAX_RETURNED_OFFERS).map(summarizeStoredOffer),
          searchedAt: null
        };
      }
      brief = trip.brief;
      tripId = trip.id;
      liveSource = "live_trip";
    } else {
      const draft = input.draftId
        ? await this.#store.getTripPlanDraft(userId, input.draftId, this.#now())
        : await this.#store.findOpenTripPlanDraft(userId, this.#now());
      if (!draft) return emptyResult("no_trip", airlineCode);
      if (draft.status !== "awaiting_confirmation" || !draft.confirmationSnapshot) {
        return {
          ...emptyResult("needs_confirmation", airlineCode),
          draftId: draft.id
        };
      }
      brief = draft.confirmationSnapshot.input.brief;
      draftId = draft.id;
      liveSource = "live_prepared_trip";
    }

    if (!this.#provider) {
      return {
        status: storedOfferCount > 0 ? "no_matches" : "unavailable",
        source: storedOfferCount > 0 ? "stored_trip" : null,
        tripId,
        draftId,
        airlineCode,
        route: routeLabel(brief),
        departureDate: brief.departureWindow.start,
        storedOfferCount,
        matchingOfferCount: 0,
        offers: [],
        searchedAt: null,
        ...(!storedOfferCount ? { errorCode: "provider_not_configured" } : {})
      };
    }

    const searchedAt = this.#now().toISOString();
    try {
      const results = await Promise.all(
        buildSearchSpecs(brief).map((spec) => this.#provider!.search(spec.request))
      );
      const live = deduplicateLiveOffers(results.flatMap((result) => result.offers));
      const matching = filterByAirline(live, airlineCode);
      return {
        status: matching.length > 0 ? "found" : "no_matches",
        source: liveSource,
        tripId,
        draftId,
        airlineCode,
        route: routeLabel(brief),
        departureDate: brief.departureWindow.start,
        storedOfferCount,
        matchingOfferCount: matching.length,
        offers: matching.slice(0, MAX_RETURNED_OFFERS).map((offer) =>
          summarizeLiveOffer(offer, searchedAt)
        ),
        searchedAt
      };
    } catch (error) {
      return {
        status: "unavailable",
        source: liveSource,
        tripId,
        draftId,
        airlineCode,
        route: routeLabel(brief),
        departureDate: brief.departureWindow.start,
        storedOfferCount,
        matchingOfferCount: 0,
        offers: [],
        searchedAt,
        errorCode: error instanceof FlightSearchProviderError ? error.code : "unknown"
      };
    }
  }
}

function hasFreshOffers(offers: OfferSnapshot[], now: Date): boolean {
  const threshold = now.getTime() - STORED_OFFER_FRESHNESS_MS;
  return offers.every((offer) => Date.parse(offer.observedAt) >= threshold);
}

function emptyResult(
  status: Extract<FlightLookupResult["status"], "needs_confirmation" | "no_trip">,
  airlineCode: string | null
): FlightLookupResult {
  return {
    status,
    source: null,
    tripId: null,
    draftId: null,
    airlineCode,
    route: null,
    departureDate: null,
    storedOfferCount: 0,
    matchingOfferCount: 0,
    offers: [],
    searchedAt: null
  };
}

function filterByAirline<T extends {
  primaryAirlineCode: string;
  participatingAirlineCodes: string[];
}>(offers: T[], airlineCode: string | null): T[] {
  if (!airlineCode) return offers;
  return offers.filter((offer) =>
    offer.primaryAirlineCode === airlineCode
    || offer.participatingAirlineCodes.includes(airlineCode)
  );
}

function deduplicateLiveOffers(offers: VerifiedOfferCandidate[]): VerifiedOfferCandidate[] {
  const best = new Map<string, VerifiedOfferCandidate>();
  for (const offer of offers) {
    const current = best.get(offer.itineraryKey);
    if (!current || Number(offer.priceAmount) < Number(current.priceAmount)) {
      best.set(offer.itineraryKey, offer);
    }
  }
  return [...best.values()].sort((left, right) =>
    Number(left.priceAmount) - Number(right.priceAmount)
  );
}

function summarizeStoredOffer(offer: OfferSnapshot): FlightLookupOffer {
  const snapshot = offer.snapshot;
  return {
    itineraryKey: offer.itineraryKey,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    primaryAirlineCode: offer.primaryAirlineCode,
    participatingAirlineCodes: offer.participatingAirlineCodes,
    route: stringValue(snapshot.route),
    stops: numberValue(snapshot.stops),
    durationMinutes: Math.round(numberValue(snapshot.durationSeconds) / 60),
    flightNumbers: stringArray(snapshot.flightNumbers),
    segments: segmentArray(snapshot.segments),
    evidenceUrl: offer.evidence[0]?.url ?? null,
    observedAt: offer.observedAt,
    expiresAt: offer.expiresAt
  };
}

function summarizeLiveOffer(
  offer: VerifiedOfferCandidate,
  searchedAt: string
): FlightLookupOffer {
  const metrics = deriveOfferMetrics(offer.slices);
  return {
    itineraryKey: offer.itineraryKey,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    primaryAirlineCode: offer.primaryAirlineCode,
    participatingAirlineCodes: offer.participatingAirlineCodes,
    route: metrics.route,
    stops: metrics.stops,
    durationMinutes: Math.round(metrics.durationSeconds / 60),
    flightNumbers: metrics.flightNumbers,
    segments: segmentArray(metrics.segments),
    evidenceUrl: offer.evidence[0]?.url ?? null,
    observedAt: searchedAt,
    expiresAt: offer.expiresAt ?? null
  };
}

function routeLabel(brief: TripBrief): string {
  if (brief.tripType === "multi_city" && brief.legs?.length) {
    return [
      brief.legs[0]!.originAirports.join("/"),
      ...brief.legs.map((leg) => leg.destinationAirports.join("/"))
    ].join(" → ");
  }
  return `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function segmentArray(value: unknown): FlightLookupOffer["segments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const segment = item as Record<string, unknown>;
    return [{
      airlineCode: stringValue(segment.airlineCode),
      airline: stringValue(segment.airline),
      flightNumber: stringValue(segment.flightNumber),
      origin: stringValue(segment.origin),
      destination: stringValue(segment.destination),
      departure: stringValue(segment.departure),
      arrival: stringValue(segment.arrival)
    }];
  });
}
