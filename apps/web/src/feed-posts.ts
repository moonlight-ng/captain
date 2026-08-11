import {
  isCheckpointEventType,
  isSpokenCheckpointEventType,
  isTravellerCheckpointEventType
} from "@agents/flight-domain/trip-checkpoints";

import type { FlightOfferSnapshot, LegSearchSnapshot, TripActivity, TripActivityChannel } from "./domain.js";
import { activityLabel, dateLabel, formatMoney } from "./format.js";

/** Spoken Telegram deliveries vs quieter lifecycle events. Feed shows events only. */
export type FeedPostKind = "update" | "event";

/** Who performed the action — traveller UI maps `traveller` → "You". */
export type FeedPostAuthor = "captain" | "traveller";

export type FeedPost = {
  id: string;
  body: string;
  createdAt: string;
  channel: TripActivityChannel;
  eventType: string;
  kind: FeedPostKind;
  author: FeedPostAuthor;
  action?: {
    label: string;
    onClick: () => void;
  };
};

/** Compact flight identity stamped into trip_leg_flight_* payloads. */
export type LegFlightSelectionSummary = {
  airlineCode: string;
  flightNumber: string;
  departureDate: string;
  stops: number;
  durationMinutes: number;
  priceAmount: string | null;
  currency: string | null;
};

const FLIGHT_SELECTION_EVENT_TYPES = new Set([
  "trip_leg_flight_selected",
  "trip_leg_flight_unselected",
  "flight_selected",
  "flight_unselected"
]);

export function feedPostAuthor(item: TripActivity | string): FeedPostAuthor {
  if (typeof item === "string") {
    return isTravellerCheckpointEventType(item) ? "traveller" : "captain";
  }
  if (FLIGHT_SELECTION_EVENT_TYPES.has(item.eventType)) {
    return item.payload.selectedBy === "agent" ? "captain" : "traveller";
  }
  return isTravellerCheckpointEventType(item.eventType) ? "traveller" : "captain";
}

/**
 * Progress journal: lifecycle checkpoint events only. Spoken Telegram deliveries
 * stay in chat; chat mirrors and non-checkpoint audit rows are hidden.
 */
export function feedPostsFromActivity(
  activity: TripActivity[],
  titleFor?: (item: TripActivity) => string
): FeedPost[] {
  return activity
    .filter((item) => isLifecycleFeedItem(item))
    .map((item) => {
      const body = titleFor?.(item)?.trim()
        || activityFeedLine(item.eventType);
      return {
        id: item.id,
        body,
        createdAt: item.createdAt,
        channel: item.channel ?? "system",
        eventType: item.eventType,
        kind: "event" as FeedPostKind,
        author: feedPostAuthor(item)
      };
    });
}

function isLifecycleFeedItem(item: TripActivity): boolean {
  if (!isCheckpointEventType(item.eventType)) return false;
  // Telegram / spoken deliveries are messages — not trip events in the feed.
  if (isSpokenCheckpointEventType(item.eventType)) return false;
  return true;
}

/** Attach a single action to the newest captain event (e.g. Open flight). */
export function withFeedUpdateAction(
  posts: FeedPost[],
  action?: FeedPost["action"]
): FeedPost[] {
  if (!action) return posts;
  const index = posts.findIndex((post) => post.author === "captain");
  if (index < 0) return posts;
  return posts.map((post, i) => (i === index ? { ...post, action } : post));
}

/** Agent-voice line for a lifecycle checkpoint. */
export function activityFeedLine(eventType: string): string {
  const lines: Record<string, string> = {
    trip_tracking_started: "Started tracking this trip.",
    trip_plan_changed: "Updated the trip plan.",
    trip_leg_flight_selected: "Selected a flight.",
    trip_leg_flight_unselected: "Stopped watching a flight.",
    flight_selected: "Selected a flight.",
    flight_unselected: "Stopped watching a flight.",
    trip_pause: "Paused tracking.",
    trip_resume: "Resumed tracking.",
    trip_cancel: "Stopped tracking.",
    trip_complete: "Marked this trip complete.",
    tracking_completed: "Finished the tracking run.",
    trip_replaced: "Replaced this trip.",
    telegram_notification: "Sent a Telegram update.",
    captain_update: "Sent an update."
  };
  return lines[eventType] ?? activityLabel(eventType);
}

export function legFlightSummaryFromSnapshot(
  snapshot: LegSearchSnapshot,
  flightKey: string
): LegFlightSelectionSummary | null {
  const flight = snapshot.flights.find((candidate) => candidate.key === flightKey);
  if (!flight) return null;
  const offer = bestOffer(flightKey, snapshot.offers);
  const first = flight.segments[0];
  return {
    airlineCode: flight.primaryAirlineCode,
    flightNumber: first?.flightNumber ?? flight.primaryAirlineCode,
    departureDate: flight.departureDate,
    stops: flight.stops,
    durationMinutes: flight.durationMinutes,
    priceAmount: offer?.priceAmount ?? null,
    currency: offer?.currency ?? null
  };
}

export function legFlightSelectionFeedTitle(input: {
  eventType: string;
  routeLabel: string;
  flight?: LegFlightSelectionSummary | null;
  previousFlight?: LegFlightSelectionSummary | null;
  previousFlightKey?: string | null;
}): string | null {
  const { eventType, routeLabel, flight, previousFlight, previousFlightKey } = input;
  if (eventType === "trip_leg_flight_unselected") {
    return flight
      ? `Stopped watching ${flightIdentity(flight)} on ${routeLabel}.`
      : `Stopped watching a flight on ${routeLabel}.`;
  }
  if (eventType !== "trip_leg_flight_selected") return null;
  if (previousFlightKey || previousFlight) {
    const next = flight ? `${flightIdentity(flight)}${flightDetailsSuffix(flight)}` : "another flight";
    const was = previousFlight
      ? `${flightIdentity(previousFlight)}${previousFlightDetailsSuffix(previousFlight)}`
      : null;
    return was
      ? `Changed ${routeLabel} to ${next} (was ${was}).`
      : `Changed ${routeLabel} to ${next}.`;
  }
  if (flight) {
    return `Selected ${flightIdentity(flight)} for ${routeLabel}${flightDetailsSuffix(flight)}.`;
  }
  return `Selected a flight for ${routeLabel}.`;
}

function flightIdentity(flight: LegFlightSelectionSummary): string {
  return flight.flightNumber.trim() || flight.airlineCode;
}

function flightDetailsSuffix(flight: LegFlightSelectionSummary): string {
  const parts = [
    shortDate(flight.departureDate),
    moneyPart(flight),
    stopsLabel(flight.stops)
  ].filter(Boolean);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

function previousFlightDetailsSuffix(flight: LegFlightSelectionSummary): string {
  const parts = [
    moneyPart(flight),
    stopsLabel(flight.stops)
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function moneyPart(flight: LegFlightSelectionSummary): string | null {
  if (!flight.priceAmount || !flight.currency) return null;
  return formatMoney(Number(flight.priceAmount), flight.currency);
}

function shortDate(value: string): string {
  return dateLabel(value).replace(/,\s*\d{4}$/u, "");
}

function stopsLabel(stops: number): string {
  if (stops <= 0) return "direct";
  return stops === 1 ? "1 stop" : `${stops} stops`;
}

function bestOffer(
  flightKey: string,
  offers: readonly FlightOfferSnapshot[]
): FlightOfferSnapshot | null {
  const matching = offers.filter((offer) => offer.flightKey === flightKey);
  if (matching.length === 0) return null;
  return matching.reduce((best, offer) =>
    Number(offer.priceAmount) < Number(best.priceAmount) ? offer : best
  );
}
