import {
  CHECKPOINT_LIFECYCLE_SHADOWED_BY_KIND,
  isCheckpointEventType,
  isCheckpointNotificationKind,
  isSpokenCheckpointEventType,
  isTravellerCheckpointEventType
} from "@agents/flight-domain/trip-checkpoints";

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

export function feedPostAuthor(eventType: string): FeedPostAuthor {
  return isTravellerCheckpointEventType(eventType) ? "traveller" : "captain";
}

/**
 * Progress journal: checkpoint events only. Spoken Telegram deliveries suppress
 * quieter lifecycle twins. Chat mirrors and non-checkpoint audit rows are hidden.
 */
export function feedPostsFromActivity(
  activity: TripActivity[],
  titleFor?: (item: TripActivity) => string
): FeedPost[] {
  const shadowedCheckpoints = new Set<string>();
  const legacySuppressedEventTypes = new Set<string>();
  for (const item of activity) {
    if (!isSpokenCheckpointEventType(item.eventType)) continue;
    const kind = typeof item.payload.kind === "string" ? item.payload.kind : null;
    if (!kind || !isCheckpointNotificationKind(kind)) continue;
    const checkpointKey = checkpointKeyFor(item);
    for (const eventType of CHECKPOINT_LIFECYCLE_SHADOWED_BY_KIND[kind] ?? []) {
      if (checkpointKey) {
        shadowedCheckpoints.add(shadowKey(eventType, checkpointKey));
      } else {
        legacySuppressedEventTypes.add(eventType);
      }
    }
  }

  return activity
    .filter((item) => {
      if (!isCheckpointFeedItem(item)) return false;
      const checkpointKey = checkpointKeyFor(item);
      return checkpointKey
        ? !shadowedCheckpoints.has(shadowKey(item.eventType, checkpointKey))
        : !legacySuppressedEventTypes.has(item.eventType);
    })
    .map((item) => {
      const spoken = Boolean(item.body?.trim()) && isSpokenCheckpointEventType(item.eventType);
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

function checkpointKeyFor(item: TripActivity): string | null {
  return typeof item.payload.checkpointKey === "string" && item.payload.checkpointKey.trim()
    ? item.payload.checkpointKey
    : null;
}

function shadowKey(eventType: string, checkpointKey: string): string {
  return `${eventType}\u0000${checkpointKey}`;
}

function isCheckpointFeedItem(item: TripActivity): boolean {
  if (!isCheckpointEventType(item.eventType)) return false;
  if (isSpokenCheckpointEventType(item.eventType)) {
    const kind = typeof item.payload.kind === "string" ? item.payload.kind : null;
    // Legacy rows without kind stay visible; new writers always set kind.
    return kind == null || isCheckpointNotificationKind(kind);
  }
  return true;
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

/** Agent-voice fallback when a lifecycle checkpoint has no spoken body. */
export function activityFeedLine(eventType: string): string {
  const lines: Record<string, string> = {
    trip_tracking_started: "Started tracking this trip.",
    trip_plan_changed: "Updated the trip plan.",
    trip_leg_flight_selected: "Started watching a flight.",
    trip_leg_flight_unselected: "Stopped watching a flight.",
    flight_selected: "Added a flight to watch.",
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
