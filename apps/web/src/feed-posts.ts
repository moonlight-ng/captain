import {
  isCheckpointEventType,
  isSpokenCheckpointEventType,
  isTravellerCheckpointEventType
} from "@agents/flight-domain/trip-checkpoints";

import type { TripActivity, TripActivityChannel } from "./domain.js";
import { activityLabel } from "./format.js";

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

export function feedPostAuthor(eventType: string): FeedPostAuthor {
  return isTravellerCheckpointEventType(eventType) ? "traveller" : "captain";
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
        author: feedPostAuthor(item.eventType)
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
