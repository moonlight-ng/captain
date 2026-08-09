import type { CompletedProviderOffer } from "./contracts.js";

export const DISCOVERY_SEARCH_SPEC_LIMIT = 1;
export const TRACKING_SEARCH_SPEC_LIMIT = 1;
export const CURRENT_OFFER_RETENTION_MS = 7 * 86_400_000;
export const PRICE_HISTORY_RETENTION_MS = 400 * 86_400_000;
export const WATCH_DATA_PRUNE_INTERVAL_MS = 24 * 3_600_000;
export const MAX_RETAINED_OFFERS_PER_SEARCH = 60;
/** One search a day. Fares move day to day, not hour to hour. */
export const TRACKING_CHECK_INTERVAL_MS = 24 * 3_600_000;
/** A backstop for a trip whose departure never arrives. */
export const MAX_TRACKING_RUN_MS = 400 * 86_400_000;

export function retainSearchOffers(offers: CompletedProviderOffer[]): CompletedProviderOffer[] {
  const bestByItinerary = new Map<string, CompletedProviderOffer>();
  for (const candidate of offers) {
    const compact = { ...candidate, snapshot: compactOfferSnapshot(candidate.snapshot) };
    const current = bestByItinerary.get(compact.itineraryKey);
    if (!current || compact.price < current.price || (compact.price === current.price && compareOffers(compact, current) < 0)) {
      bestByItinerary.set(compact.itineraryKey, compact);
    }
  }

  const ranked = [...bestByItinerary.values()].sort(compareOffers);
  const cheapestByDates = new Map<string, CompletedProviderOffer>();
  for (const offer of ranked) {
    const key = departureDateKey(offer.snapshot);
    if (!key) continue;
    const current = cheapestByDates.get(key);
    if (!current || offer.price < current.price) cheapestByDates.set(key, offer);
  }
  const offersByAirline = new Map<string, CompletedProviderOffer[]>();
  for (const offer of ranked) {
    const airline = primaryAirline(offer.snapshot) || offer.primaryAirlineCode || "UNKNOWN";
    const airlineOffers = offersByAirline.get(airline) ?? [];
    airlineOffers.push(offer);
    offersByAirline.set(airline, airlineOffers);
  }

  const airlineOrder = [...offersByAirline.entries()]
    .sort((left, right) => compareOffers(left[1][0]!, right[1][0]!))
    .map(([airline]) => airline);
  const representative: CompletedProviderOffer[] = [];
  for (let depth = 0; representative.length < ranked.length; depth += 1) {
    for (const airline of airlineOrder) {
      const offer = offersByAirline.get(airline)?.[depth];
      if (offer) representative.push(offer);
    }
  }
  // A window comparison is only truthful when even an expensive day survives
  // compaction. Reserve its cheapest offer first, then use the remaining slots
  // for the normal airline-diverse ranking.
  const dateCoverage = [...cheapestByDates.values()].sort(compareOffers);
  const coveredIds = new Set(dateCoverage.map((offer) => offer.itineraryKey));
  return [
    ...dateCoverage,
    ...representative.filter((offer) => !coveredIds.has(offer.itineraryKey))
  ].slice(0, MAX_RETAINED_OFFERS_PER_SEARCH);
}

export function compactOfferSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    route: boundedString(snapshot.route, 300),
    departureDates: stringArray(snapshot.departureDates, 6, 10),
    airlineCodes: stringArray(snapshot.airlineCodes, 8, 3),
    flightNumbers: stringArray(snapshot.flightNumbers, 12, 16),
    stops: boundedNumber(snapshot.stops, 0, 12),
    durationSeconds: boundedNumber(snapshot.durationSeconds, 0, 172_800),
    conditions: stringRecord(snapshot.conditions, 12, 200),
    segments: compactSegments(snapshot.segments)
  };
}

function departureDateKey(snapshot: Record<string, unknown>): string {
  return stringArray(snapshot.departureDates, 6, 10).join("|");
}

/**
 * Tracking runs until the trip departs. The question Captain answers — when is
 * the right moment to book — is only settled on the day of the flight, and for
 * a trip months out a fixed multi-day run would stop watching long before then.
 */
export function trackingRunEndsAt(startedAt: Date, departureStart: string): Date {
  const ceiling = startedAt.getTime() + MAX_TRACKING_RUN_MS;
  const departure = Date.parse(`${departureStart}T23:59:59.999Z`);
  if (!Number.isFinite(departure)) return new Date(ceiling);
  // A departure already in the past still earns one check, so that asking
  // Captain to track does something visible rather than completing instantly.
  return new Date(Math.min(
    ceiling,
    Math.max(departure, startedAt.getTime() + TRACKING_CHECK_INTERVAL_MS)
  ));
}

function compareOffers(left: CompletedProviderOffer, right: CompletedProviderOffer): number {
  return retentionScore(left) - retentionScore(right)
    || left.price - right.price
    || left.itineraryKey.localeCompare(right.itineraryKey);
}

function retentionScore(offer: CompletedProviderOffer): number {
  const stops = boundedNumber(offer.snapshot.stops, 0, 12);
  const durationHours = boundedNumber(offer.snapshot.durationSeconds, 0, 172_800) / 3_600;
  return offer.price + stops * 50 + durationHours * 2;
}

function primaryAirline(snapshot: Record<string, unknown>): string {
  return stringArray(snapshot.airlineCodes, 1, 3)[0] ?? "";
}

function compactSegments(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const segment = candidate as Record<string, unknown>;
    return [{
      airlineCode: boundedString(segment.airlineCode, 3),
      airline: boundedString(segment.airline, 100),
      flightNumber: boundedString(segment.flightNumber, 16),
      origin: boundedString(segment.origin, 3),
      destination: boundedString(segment.destination, 3),
      departure: boundedString(segment.departure, 40),
      arrival: boundedString(segment.arrival, 40)
    }];
  });
}

function boundedString(value: unknown, maximumLength: number): string {
  return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maximumItems)
    .map((item) => item.slice(0, maximumLength));
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.min(maximum, Math.max(minimum, candidate)) : minimum;
}

function stringRecord(value: unknown, maximumItems: number, maximumLength: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .slice(0, maximumItems)
      .map(([key, item]) => [key.slice(0, 80), item.slice(0, maximumLength)])
  );
}
