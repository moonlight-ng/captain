import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { TripService } from "../services/trips/service.js";
import type { TripActivity } from "../src/domain.js";
import { activityFeedLine, feedPostAuthor, feedPostsFromActivity } from "../src/feed-posts.js";
import { defaultTestBrief } from "./support.js";

function activity(partial: Partial<TripActivity> & Pick<TripActivity, "id" | "eventType">): TripActivity {
  return {
    payload: {},
    createdAt: "2026-08-09T12:00:00.000Z",
    body: null,
    channel: "system",
    notificationId: null,
    sourceMessageId: null,
    ...partial
  };
}

describe("feedPostsFromActivity", () => {
  it("treats delivered Captain updates as first-person update posts", () => {
    const posts = feedPostsFromActivity([
      activity({
        id: "n1",
        eventType: "captain_update",
        payload: { kind: "tracking_started" },
        body: "Plan confirmed. Now checking flights…",
        channel: "telegram",
        notificationId: "notif-1"
      }),
      activity({ id: "l1", eventType: "trip_tracking_started" }),
      activity({ id: "l2", eventType: "trip_created" })
    ]);

    expect(posts.map((post) => [post.kind, post.id, post.body, post.author])).toEqual([
      ["update", "n1", "Plan confirmed. Now checking flights…", "captain"],
      ["event", "l2", "Created this trip.", "captain"]
    ]);
  });

  it("attributes only explicit traveller mutations to the traveller", () => {
    expect(feedPostAuthor("trip_title_updated")).toBe("traveller");
    expect(feedPostAuthor("trip_created")).toBe("captain");
    expect(feedPostAuthor("trip_brief_updated")).toBe("captain");
    expect(feedPostAuthor("trip_tracking_started")).toBe("captain");
    expect(feedPostAuthor("tracking_completed")).toBe("captain");
    expect(feedPostsFromActivity([
      activity({ id: "r1", eventType: "trip_title_updated", payload: { title: "Summer" } })
    ])[0]).toMatchObject({
      author: "traveller",
      body: "Renamed this trip.",
      kind: "event"
    });
  });

  it("falls back to agent-voice lines for silent lifecycle events", () => {
    expect(activityFeedLine("trip_refresh")).toBe("Ran a manual check.");
    expect(feedPostsFromActivity([
      activity({ id: "a1", eventType: "trip_refresh" })
    ])[0]).toMatchObject({ body: "Ran a manual check.", author: "traveller" });
  });
});

describe("trip feed audit writes", () => {
  it("records the exact Telegram text as a captain_update event", async () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 42,
      telegramChatId: 42,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → LHR",
      brief: defaultTestBrief()
    });
    await service.action(owner.id, created.trip.id, {
      type: "track",
      expectedVersion: created.trip.version
    });

    const notification = (await store.listPendingNotifications(now, 10))[0];
    expect(notification).toMatchObject({
      tripId: created.trip.id,
      kind: "tracking_started"
    });

    const body = "Plan confirmed. Now checking flights…";
    await store.markNotificationSent(notification!.id, 9001, body, now);

    const feed = await store.listTripActivity(owner.id, created.trip.id);
    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "captain_update",
        body,
        channel: "telegram",
        notificationId: notification!.id
      })
    ]));
  });

  it("records trip-scoped assistant replies on the trip feed", async () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 43,
      telegramChatId: 43,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → CDG",
      brief: defaultTestBrief({ destinationAirports: ["CDG"] })
    });
    await store.setActiveTrip(owner.id, created.trip.id, now);

    const messageId = await store.appendMessage(
      owner.id,
      "assistant",
      "I am watching BA123 for you.",
      now
    );

    const feed = await store.listTripActivity(owner.id, created.trip.id);
    expect(feed[0]).toMatchObject({
      eventType: "telegram_message",
      body: "I am watching BA123 for you.",
      channel: "telegram",
      sourceMessageId: messageId
    });
  });
});
