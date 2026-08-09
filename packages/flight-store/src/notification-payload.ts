import { formatTripGoal, type OfferSnapshot, type Trip, type TravellerProfile } from "@agents/flight-domain";

/**
 * The shape of the market behind a trip, rather than one fare out of it. The
 * first thing Captain says about a new trip is an overview, and a single price
 * is not one: what a traveller needs to know on day one is what the route
 * costs, how wide the spread is, and how much Captain had to choose from.
 */
export type OfferRangeSummary = {
  count: number;
  low: number;
  high: number;
  currency: string;
};

export type OfferDateCombinationSummary = {
  departureDates: string[];
  low: number;
  count: number;
};

export type OfferDateSummary = {
  currency: string;
  tripType: Trip["brief"]["tripType"];
  combinations: OfferDateCombinationSummary[];
  searchWindows: Array<{ start: string; end: string }>;
  searchedCombinationCount: number;
  cheapestDepartureDates: string[];
  cheapest: number;
  highestCombinationLow: number;
};

export function offerRangeSummary(offers: OfferSnapshot[]): OfferRangeSummary | null {
  const first = offers[0];
  if (!first) return null;
  const comparable = offers.filter((offer) => offer.currency === first.currency);
  const prices = comparable.map((offer) => offer.price).filter(Number.isFinite);
  if (prices.length === 0) return null;
  return {
    count: comparable.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    currency: first.currency
  };
}

/** The cheapest verified fare for every departure-date combination searched. */
export function offerDateSummary(
  offers: OfferSnapshot[],
  trip: Pick<Trip, "brief">
): OfferDateSummary | null {
  const first = offers[0];
  if (!first) return null;
  const grouped = new Map<string, OfferDateCombinationSummary>();
  for (const offer of offers) {
    if (offer.currency !== first.currency || !Number.isFinite(offer.price)) continue;
    const departureDates = snapshotDepartureDates(offer.snapshot);
    if (departureDates.length === 0) continue;
    const key = departureDates.join("|");
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { departureDates, low: offer.price, count: 1 });
    } else {
      current.low = Math.min(current.low, offer.price);
      current.count += 1;
    }
  }
  const combinations = [...grouped.values()].sort((left, right) =>
    left.departureDates.join("|").localeCompare(right.departureDates.join("|"))
  );
  if (combinations.length === 0) return null;
  const cheapestCombination = [...combinations].sort((left, right) =>
    left.low - right.low || left.departureDates.join("|").localeCompare(right.departureDates.join("|"))
  )[0]!;
  const searchWindows = trip.brief.tripType === "multi_city"
    ? (trip.brief.legs ?? []).map((leg) => leg.departureWindow)
    : [trip.brief.departureWindow];
  return {
    currency: first.currency,
    tripType: trip.brief.tripType,
    combinations,
    searchWindows,
    searchedCombinationCount: searchWindows.reduce(
      (count, window) => count * inclusiveDateCount(window.start, window.end),
      1
    ),
    cheapestDepartureDates: cheapestCombination.departureDates,
    cheapest: cheapestCombination.low,
    highestCombinationLow: Math.max(...combinations.map((combination) => combination.low))
  };
}

function inclusiveDateCount(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return 0;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function snapshotDepartureDates(snapshot: Record<string, unknown>): string[] {
  if (!Array.isArray(snapshot.departureDates)) return [];
  return snapshot.departureDates.filter((value): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  );
}

/**
 * Facts every automatic message carries. The goal is stamped at enqueue time
 * as immutable decision context, but remains internal rather than being
 * printed in the traveller-facing message.
 */
export function notificationGoalPayload(
  trip: Trip,
  profile: Pick<TravellerProfile, "rankingMode">
): { tripTitle: string; tripGoal: string } {
  return {
    tripTitle: trip.title,
    tripGoal: formatTripGoal({ brief: trip.brief, rankingMode: profile.rankingMode })
  };
}
