import {
  summarizePriceHistory,
  type PriceHistorySummary
} from "@agents/flight-domain";
import type { TrackedFlightPrices } from "@agents/flight-store";

export type TrackedPriceHistoryPayload = PriceHistorySummary & {
  itineraryKey: string;
};

/**
 * A selection exists as soon as someone starts watching a flight, while its
 * first price observation can land later. Keep that gap represented as null so
 * the dashboard never receives a partial chart payload.
 */
export function toTrackedPriceHistory(
  tracked: TrackedFlightPrices | null,
  departureDate: string
): TrackedPriceHistoryPayload | null {
  if (!tracked) return null;
  const summary = summarizePriceHistory({
    observations: tracked.observations,
    currency: tracked.currency,
    departureDate
  });
  return summary ? { itineraryKey: tracked.itineraryKey, ...summary } : null;
}
