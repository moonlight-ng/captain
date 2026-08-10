/**
 * Trip events are progress checkpoints: durable evidence the trip moved toward
 * (or away from) finding and watching the right flights. Freeform chat is not
 * a checkpoint. Telegram is the outward signal for checkpoints marked below.
 *
 * This module stays free of Node-only imports so the web app can consume it via
 * `@agents/flight-domain/trip-checkpoints`.
 */

/** Notification kinds that represent traveller-facing checkpoints. */
export const CHECKPOINT_NOTIFICATION_KINDS = [
  "tracking_started",
  "initial_results",
  "tracking_activation",
  "price_drop",
  "price_rise",
  "new_best",
  "tracking_summary",
  "plan_changed",
  "tracking_paused",
  "tracking_resumed",
  "trip_closed"
] as const;

export type CheckpointNotificationKind = (typeof CHECKPOINT_NOTIFICATION_KINDS)[number];

/** Lifecycle / spoken event types that belong in the traveller progress journal. */
export const CHECKPOINT_EVENT_TYPES = [
  "trip_tracking_started",
  "trip_plan_changed",
  "trip_leg_flight_selected",
  "trip_leg_flight_unselected",
  "flight_selected",
  "flight_unselected",
  "trip_pause",
  "trip_resume",
  "tracking_completed",
  "trip_cancel",
  "trip_complete",
  "trip_replaced",
  "captain_update",
  // Legacy spoken name — no longer written, still filtered for old rows.
  "telegram_notification"
] as const;

export type CheckpointEventType = (typeof CHECKPOINT_EVENT_TYPES)[number];

const CHECKPOINT_EVENT_TYPE_SET = new Set<string>(CHECKPOINT_EVENT_TYPES);
const CHECKPOINT_NOTIFICATION_KIND_SET = new Set<string>(CHECKPOINT_NOTIFICATION_KINDS);

/** Spoken deliveries that suppress quieter lifecycle twins in the feed. */
export const CHECKPOINT_LIFECYCLE_SHADOWED_BY_KIND: Record<string, readonly string[]> = {
  tracking_started: ["trip_tracking_started"],
  tracking_summary: ["tracking_completed", "trip_complete"],
  tracking_paused: ["trip_pause"],
  tracking_resumed: ["trip_resume"],
  plan_changed: ["trip_plan_changed"],
  trip_closed: ["trip_cancel", "trip_complete", "trip_replaced"]
};

/** Explicit traveller-driven checkpoint mutations (Feed author → "You"). */
export const TRAVELLER_CHECKPOINT_EVENT_TYPES = new Set<string>([
  "trip_plan_changed",
  "trip_pause",
  "trip_resume",
  "trip_cancel",
  "trip_complete",
  "trip_leg_flight_selected",
  "trip_leg_flight_unselected",
  "flight_selected",
  "flight_unselected"
]);

const SPOKEN_CHECKPOINT_EVENT_TYPES = new Set<string>([
  "captain_update",
  "telegram_notification"
]);

/** Progress-relevant brief fields — structural subset of TripBrief. */
export type MaterialTripPlanFields = {
  originAirports: readonly string[];
  destinationAirports: readonly string[];
  tripType: string;
  departureWindow: { start: string; end: string };
  stayNights: unknown;
  legs?: unknown;
  cabin: string;
  maxStops: number;
  currency: string;
  maximumPrice: number | null;
  preferredAirlines: readonly string[];
  excludedAirlines: readonly string[];
};

export function isCheckpointEventType(eventType: string): boolean {
  return CHECKPOINT_EVENT_TYPE_SET.has(eventType);
}

export function isCheckpointNotificationKind(kind: string): boolean {
  return CHECKPOINT_NOTIFICATION_KIND_SET.has(kind);
}

export function isSpokenCheckpointEventType(eventType: string): boolean {
  return SPOKEN_CHECKPOINT_EVENT_TYPES.has(eventType);
}

export function isTravellerCheckpointEventType(eventType: string): boolean {
  return TRAVELLER_CHECKPOINT_EVENT_TYPES.has(eventType);
}

/**
 * True when the brief change alters route, dates, or search constraints —
 * not cosmetic fields like freeform context alone.
 */
export function isMaterialTripPlanChange(
  previous: MaterialTripPlanFields,
  next: MaterialTripPlanFields
): boolean {
  return materialPlanFingerprint(previous) !== materialPlanFingerprint(next);
}

function materialPlanFingerprint(brief: MaterialTripPlanFields): string {
  return JSON.stringify({
    originAirports: brief.originAirports,
    destinationAirports: brief.destinationAirports,
    tripType: brief.tripType,
    departureWindow: brief.departureWindow,
    stayNights: brief.stayNights,
    legs: brief.legs ?? null,
    cabin: brief.cabin,
    maxStops: brief.maxStops,
    currency: brief.currency,
    maximumPrice: brief.maximumPrice,
    preferredAirlines: brief.preferredAirlines,
    excludedAirlines: brief.excludedAirlines
  });
}

/** Map a trip action / close reason onto a checkpoint notification kind. */
export function checkpointNotificationKindForAction(
  actionType: "pause" | "resume" | "cancel" | "complete" | "replaced" | "plan_changed"
): CheckpointNotificationKind {
  switch (actionType) {
    case "pause":
      return "tracking_paused";
    case "resume":
      return "tracking_resumed";
    case "plan_changed":
      return "plan_changed";
    case "cancel":
    case "complete":
    case "replaced":
      return "trip_closed";
  }
}
