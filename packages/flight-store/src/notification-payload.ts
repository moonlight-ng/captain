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

/**
 * Facts every automatic message carries, so the worker can state what a trip
 * is for without re-reading the trip. The goal is stamped at enqueue time
 * because it is the goal the message was written against.
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
