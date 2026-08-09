import {
  airportCodeMatches,
  verifiedSegmentSchema,
  type CanonicalFlight,
  type FlightOfferSnapshot,
  type LegSearchAnalysis,
  type LegSearchPick,
  type LegSearchSnapshotRevision,
  type SearchSpecRequest,
  type Trip,
  type TripCity,
  type TripCityLeg,
  type TripGraph
} from "@agents/flight-domain";

import type { CompletedProviderOffer } from "./contracts.js";

export type MultiCityLegMatch = {
  leg: TripCityLeg;
  origin: TripCity;
  destination: TripCity;
};

export function matchingMultiCityLegs(
  trip: Trip,
  graph: TripGraph,
  request: SearchSpecRequest
): MultiCityLegMatch[] {
  if (trip.brief.tripType !== "multi_city" || request.slices.length !== 1) return [];
  const slice = request.slices[0]!;
  return graph.legs.flatMap((leg) => {
    const origin = graph.cities.find((city) => city.id === leg.originCityId);
    const destination = graph.cities.find((city) => city.id === leg.destinationCityId);
    if (
      !origin
      || !destination
      || !sameCodes(origin.airportCodes, slice.originAirports)
      || !sameCodes(destination.airportCodes, slice.destinationAirports)
      || leg.departureWindow.start !== slice.departureStart
      || leg.departureWindow.end !== slice.departureEnd
      || (leg.arriveBy ?? null) !== (slice.arriveBy ?? null)
    ) return [];
    return [{ leg, origin, destination }];
  });
}

export function multiCityLegRevision(
  match: MultiCityLegMatch,
  trip: Trip,
  offers: CompletedProviderOffer[] | null,
  errorCode: string | null,
  now: Date
): LegSearchSnapshotRevision {
  const datesRequested = enumerateDates(
    match.leg.departureWindow.start,
    match.leg.departureWindow.end
  );
  if (offers === null) {
    return {
      status: "failed",
      analysis: {
        complete: false,
        datesRequested,
        datesCompleted: [],
        failedDates: datesRequested.map((date) => ({
          date,
          code: boundedErrorCode(errorCode)
        })),
        optionsChecked: 0,
        cheapest: null,
        fastest: null,
        balanced: null,
        cheapestByDate: [],
        observedAt: null
      },
      flights: [],
      offers: [],
      completedAt: now.toISOString()
    };
  }

  const converted = convertOffers(match, trip, offers);
  const analysis = analyze(
    datesRequested,
    converted.flights,
    converted.offers,
    latestObservation(converted.offers) ?? now.toISOString(),
    trip.brief.preferredAirlines
  );
  return {
    status: "completed",
    analysis,
    flights: converted.flights.slice(0, 120),
    offers: converted.offers.slice(0, 240),
    completedAt: now.toISOString()
  };
}

function convertOffers(
  match: MultiCityLegMatch,
  trip: Trip,
  candidates: CompletedProviderOffer[]
): { flights: CanonicalFlight[]; offers: FlightOfferSnapshot[] } {
  const flights = new Map<string, CanonicalFlight>();
  const offers = new Map<string, FlightOfferSnapshot>();
  for (const candidate of candidates) {
    const segments = compactSegments(candidate.snapshot.segments);
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) continue;
    const departureDate = first.departure.slice(0, 10);
    if (
      !airportCodeMatches(match.origin.airportCodes, first.origin)
      || !airportCodeMatches(match.destination.airportCodes, last.destination)
      || departureDate < match.leg.departureWindow.start
      || departureDate > match.leg.departureWindow.end
      || (match.leg.arriveBy && last.arrival.slice(0, 10) > match.leg.arriveBy)
      || candidate.currency !== trip.brief.currency
    ) continue;
    const durationMs = Date.parse(last.arrival) - Date.parse(first.departure);
    const flight: CanonicalFlight = {
      key: candidate.itineraryKey,
      origin: first.origin,
      destination: last.destination,
      departureDate,
      segments,
      primaryAirlineCode: candidate.primaryAirlineCode,
      participatingAirlineCodes: candidate.participatingAirlineCodes,
      stops: Math.max(0, segments.length - 1),
      durationMinutes: Math.max(1, Math.round(durationMs / 60_000))
    };
    flights.set(flight.key, flight);
    const offer: FlightOfferSnapshot = {
      offerId: candidate.providerOfferId,
      flightKey: candidate.itineraryKey,
      provider: candidate.provider,
      priceAmount: candidate.priceAmount,
      currency: candidate.currency,
      evidence: candidate.evidence,
      observedAt: candidate.observedAt,
      expiresAt: candidate.expiresAt
    };
    const key = `${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`;
    const current = offers.get(key);
    if (!current || compareOffers(offer, current) < 0) offers.set(key, offer);
  }
  return {
    flights: [...flights.values()].sort(compareFlights),
    offers: [...offers.values()].sort(compareOfferSnapshots)
  };
}

function analyze(
  datesRequested: string[],
  flights: CanonicalFlight[],
  offers: FlightOfferSnapshot[],
  observedAt: string,
  preferredAirlines: string[]
): LegSearchAnalysis {
  const flightByKey = new Map(flights.map((flight) => [flight.key, flight]));
  const choices = offers.flatMap((offer) => {
    const flight = flightByKey.get(offer.flightKey);
    return flight ? [{ flight, offer, price: Number(offer.priceAmount) }] : [];
  });
  const cheapest = [...choices].sort((left, right) =>
    left.price - right.price || compareFlights(left.flight, right.flight)
  )[0] ?? null;
  const fastest = [...choices].sort((left, right) =>
    left.flight.durationMinutes - right.flight.durationMinutes
      || left.price - right.price
      || compareFlights(left.flight, right.flight)
  )[0] ?? null;
  const preferred = new Set(preferredAirlines);
  const balanced = [...choices].sort((left, right) =>
    balancedScore(left, preferred) - balancedScore(right, preferred)
      || left.price - right.price
      || compareFlights(left.flight, right.flight)
  )[0] ?? null;
  const cheapestByDate = datesRequested.flatMap((date) => {
    const choice = choices
      .filter(({ flight }) => flight.departureDate === date)
      .sort((left, right) => left.price - right.price || compareFlights(left.flight, right.flight))[0];
    return choice ? [pick(choice.flight, choice.offer)] : [];
  });
  return {
    complete: true,
    datesRequested,
    datesCompleted: datesRequested,
    failedDates: [],
    optionsChecked: flights.length,
    cheapest: cheapest ? pick(cheapest.flight, cheapest.offer) : null,
    fastest: fastest ? pick(fastest.flight, fastest.offer) : null,
    balanced: balanced ? pick(balanced.flight, balanced.offer) : null,
    cheapestByDate,
    observedAt
  };
}

function balancedScore(
  choice: { flight: CanonicalFlight; price: number },
  preferred: Set<string>
): number {
  return choice.price
    + choice.flight.durationMinutes * 0.35
    + choice.flight.stops * 50
    - (choice.flight.participatingAirlineCodes.some((code) => preferred.has(code)) ? 25 : 0);
}

function pick(flight: CanonicalFlight, offer: FlightOfferSnapshot): LegSearchPick {
  return {
    flightKey: flight.key,
    departureDate: flight.departureDate,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    durationMinutes: flight.durationMinutes,
    stops: flight.stops
  };
}

function compactSegments(value: unknown): CanonicalFlight["segments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const segment = candidate as Record<string, unknown>;
    const parsed = verifiedSegmentSchema.safeParse({
      origin: segment.origin,
      destination: segment.destination,
      departure: segment.departure,
      arrival: segment.arrival,
      marketingAirlineCode: segment.airlineCode,
      marketingAirline: segment.airline,
      flightNumber: segment.flightNumber
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function sameCodes(left: string[], right: string[]): boolean {
  return [...left].sort().join("|") === [...right].sort().join("|");
}

function enumerateDates(start: string, end: string): string[] {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return [];
  const dates: string[] = [];
  for (let value = startMs; value <= endMs; value += 86_400_000) {
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

function latestObservation(offers: FlightOfferSnapshot[]): string | null {
  return offers.map((offer) => offer.observedAt).sort().at(-1) ?? null;
}

function boundedErrorCode(errorCode: string | null): string {
  return (errorCode?.trim() || "search_failed").slice(0, 100);
}

function compareFlights(left: CanonicalFlight, right: CanonicalFlight): number {
  return left.departureDate.localeCompare(right.departureDate)
    || left.segments[0]!.departure.localeCompare(right.segments[0]!.departure)
    || left.key.localeCompare(right.key);
}

function compareOffers(left: FlightOfferSnapshot, right: FlightOfferSnapshot): number {
  return Number(left.priceAmount) - Number(right.priceAmount)
    || left.observedAt.localeCompare(right.observedAt)
    || left.offerId.localeCompare(right.offerId);
}

function compareOfferSnapshots(left: FlightOfferSnapshot, right: FlightOfferSnapshot): number {
  return left.flightKey.localeCompare(right.flightKey) || compareOffers(left, right);
}
