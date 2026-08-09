import type { TripActivity, TripActivityChannel } from "./domain.js";
import { activityLabel } from "./format.js";

/** Spoken Telegram updates vs quieter lifecycle events. */
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

/** Lifecycle events covered by a delivered Telegram notification of this kind. */
const LIFECYCLE_SHADOWED_BY_KIND: Record<string, string[]> = {
  tracking_started: ["trip_tracking_started"],
  tracking_summary: ["tracking_completed", "trip_complete"]
};

const SPOKEN_EVENT_TYPES = new Set([
  "telegram_notification",
  "telegram_message",
  "captain_update"
]);

/**
 * Explicit traveller-driven mutations. Everything else on the feed — including
 * create/brief/track lifecycle rows from planning — stays Captain.
 */
const TRAVELLER_EVENT_TYPES = new Set([
  "trip_title_updated",
  "trip_pause",
  "trip_resume",
  "trip_refresh",
  "trip_cancel",
  "trip_complete",
  "trip_leg_flight_selected",
  "trip_leg_flight_unselected",
  "flight_selected",
  "flight_unselected"
]);

export function feedPostAuthor(eventType: string): FeedPostAuthor {
  return TRAVELLER_EVENT_TYPES.has(eventType) ? "traveller" : "captain";
}

/**
 * One social stream: first-person Telegram updates (exact sent text) plus
 * quieter lifecycle events. Spoken deliveries suppress lifecycle twins.
 * Only explicit traveller mutations (rename, pause, select flight, …) are
 * attributed to the traveller; create/brief/track and spoken deliveries stay
 * Captain.
 */
export function feedPostsFromActivity(
  activity: TripActivity[],
  titleFor?: (item: TripActivity) => string
): FeedPost[] {
  const spokenKinds = new Set<string>();
  for (const item of activity) {
    if (item.eventType !== "telegram_notification" && item.eventType !== "captain_update") {
      continue;
    }
    const kind = typeof item.payload.kind === "string" ? item.payload.kind : null;
    if (kind) spokenKinds.add(kind);
  }

  const suppressed = new Set<string>();
  for (const kind of spokenKinds) {
    for (const eventType of LIFECYCLE_SHADOWED_BY_KIND[kind] ?? []) {
      suppressed.add(eventType);
    }
  }

  return activity
    .filter((item) => !suppressed.has(item.eventType))
    .map((item) => {
      const spoken = Boolean(item.body?.trim()) && SPOKEN_EVENT_TYPES.has(item.eventType);
      const body = item.body?.trim()
        || titleFor?.(item)?.trim()
        || activityFeedLine(item.eventType);
      return {
        id: item.id,
        body,
        createdAt: item.createdAt,
        channel: item.channel ?? "system",
        eventType: item.eventType,
        kind: (spoken ? "update" : "event") as FeedPostKind,
        author: feedPostAuthor(item.eventType)
      };
    });
}

/** Attach a single action to the newest spoken update (e.g. Open flight). */
export function withFeedUpdateAction(
  posts: FeedPost[],
  action?: FeedPost["action"]
): FeedPost[] {
  if (!action) return posts;
  const index = posts.findIndex((post) => post.kind === "update");
  if (index < 0) return posts;
  return posts.map((post, i) => (i === index ? { ...post, action } : post));
}

/** Agent-voice fallback when a lifecycle event has no spoken body. */
export function activityFeedLine(eventType: string): string {
  const lines: Record<string, string> = {
    trip_created: "Created this trip.",
    trip_tracking_started: "Started tracking this trip.",
    trip_brief_updated: "Updated the trip brief.",
    trip_title_updated: "Renamed this trip.",
    trip_leg_flight_selected: "Started watching a flight.",
    trip_leg_flight_unselected: "Stopped watching a flight.",
    flight_selected: "Added a flight to watch.",
    flight_unselected: "Stopped watching a flight.",
    trip_pause: "Paused tracking.",
    trip_resume: "Resumed tracking.",
    trip_refresh: "Ran a manual check.",
    trip_cancel: "Stopped tracking.",
    trip_complete: "Marked this trip complete.",
    tracking_completed: "Finished the tracking run.",
    trip_replaced: "Replaced this trip.",
    telegram_notification: "Sent a Telegram update.",
    telegram_message: "Sent a Telegram message.",
    captain_update: "Sent an update."
  };
  return lines[eventType] ?? activityLabel(eventType);
}
