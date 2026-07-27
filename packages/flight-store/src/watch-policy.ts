import type { CompletedProviderOffer } from "./contracts.js";

export const MAX_RETAINED_OFFERS_PER_SEARCH = 20;
export const DISCOVERY_SEARCH_SPEC_LIMIT = 1;
export const TRACKING_SEARCH_SPEC_LIMIT = 1;
export const CURRENT_OFFER_RETENTION_MS = 7 * 86_400_000;
export const PRICE_HISTORY_RETENTION_MS = 90 * 86_400_000;

const CHEAPEST_OFFER_SLOTS = 12;
const AIRLINE_DIVERSITY_SLOTS = MAX_RETAINED_OFFERS_PER_SEARCH - CHEAPEST_OFFER_SLOTS;

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
  const retained = new Map<string, CompletedProviderOffer>();
  for (const offer of ranked.slice(0, CHEAPEST_OFFER_SLOTS)) {
    retained.set(offer.itineraryKey, offer);
  }

  const bestByAirline = new Map<string, CompletedProviderOffer>();
  for (const offer of ranked) {
    const airline = primaryAirline(offer.snapshot);
    if (airline && !bestByAirline.has(airline)) bestByAirline.set(airline, offer);
  }
  for (const offer of [...bestByAirline.values()].sort(compareOffers)) {
    if (retained.size >= CHEAPEST_OFFER_SLOTS + AIRLINE_DIVERSITY_SLOTS) break;
    retained.set(offer.itineraryKey, offer);
  }
  for (const offer of ranked) {
    if (retained.size >= MAX_RETAINED_OFFERS_PER_SEARCH) break;
    retained.set(offer.itineraryKey, offer);
  }
  return [...retained.values()].sort(compareOffers);
}

export function compactOfferSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    route: boundedString(snapshot.route, 300),
    airlineCodes: stringArray(snapshot.airlineCodes, 8, 3),
    flightNumbers: stringArray(snapshot.flightNumbers, 12, 16),
    stops: boundedNumber(snapshot.stops, 0, 12),
    durationSeconds: boundedNumber(snapshot.durationSeconds, 0, 172_800),
    conditions: stringRecord(snapshot.conditions, 12, 200),
    segments: compactSegments(snapshot.segments)
  };
}

export function adaptiveWatchIntervalMs(cadenceHours: number, departureStart: string, now: Date): number {
  const departure = Date.parse(`${departureStart}T00:00:00.000Z`);
  const daysUntilDeparture = Number.isFinite(departure)
    ? Math.ceil((departure - now.getTime()) / 86_400_000)
    : 0;
  const adaptiveFloor = daysUntilDeparture < 0
    ? 24
    : daysUntilDeparture > 30
        ? 12
        : daysUntilDeparture > 7
          ? 6
          : 3;
  void cadenceHours;
  return adaptiveFloor * 3_600_000;
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
