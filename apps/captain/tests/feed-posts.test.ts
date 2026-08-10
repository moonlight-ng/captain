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
  it("shows lifecycle trip events and hides spoken Telegram messages", () => {
    const posts = feedPostsFromActivity([
      activity({
        id: "n1",
        eventType: "captain_update",
        payload: { kind: "initial_results" },
        body: "PAR → NYC is $361.69–$372.28 one-way across 4–8 Nov. Open the trip to compare.",
        channel: "telegram",
        notificationId: "notif-1"
      }),
      activity({ id: "l1", eventType: "trip_tracking_started" }),
      activity({ id: "l2", eventType: "trip_created" })
    ]);

    expect(posts.map((post) => [post.kind, post.id, post.body, post.author])).toEqual([
      ["event", "l1", "Started tracking this trip.", "captain"]
    ]);
  });

  it("hides non-checkpoint audit and chat mirrors", () => {
    const posts = feedPostsFromActivity([
      activity({ id: "c1", eventType: "trip_created" }),
      activity({ id: "t1", eventType: "trip_title_updated", payload: { title: "Summer" } }),
      activity({ id: "r1", eventType: "trip_refresh" }),
      activity({
        id: "m1",
        eventType: "telegram_message",
        body: "Itinerary ready to confirm.",
        channel: "telegram"
      }),
      activity({
        id: "ops",
        eventType: "captain_update",
        payload: { kind: "inventory_gap" },
        body: "Inventory gap",
        channel: "telegram"
      }),
      activity({ id: "w1", eventType: "trip_leg_flight_selected", payload: { legId: "leg-1" } })
    ]);

    expect(posts.map((post) => post.id)).toEqual(["w1"]);
  });

  it("keeps lifecycle twins visible when a Telegram ack was delivered", () => {
    const posts = feedPostsFromActivity([
      activity({
        id: "new-plan",
        eventType: "trip_plan_changed",
        payload: { checkpointKey: "trip:plan_changed:3", tripVersion: 3 }
      }),
      activity({
        id: "old-spoken",
        eventType: "captain_update",
        payload: { kind: "plan_changed", checkpointKey: "trip:plan_changed:2" },
        body: "I’ve updated the plan.",
        channel: "telegram"
      }),
      activity({
        id: "old-plan",
        eventType: "trip_plan_changed",
        payload: { checkpointKey: "trip:plan_changed:2", tripVersion: 2 }
      })
    ]);

    expect(posts.map((post) => post.id)).toEqual(["new-plan", "old-plan"]);
  });

  it("attributes only traveller checkpoint mutations to the traveller", () => {
    expect(feedPostAuthor("trip_plan_changed")).toBe("traveller");
    expect(feedPostAuthor("trip_pause")).toBe("traveller");
    expect(feedPostAuthor("trip_tracking_started")).toBe("captain");
    expect(feedPostAuthor("tracking_completed")).toBe("captain");
    expect(feedPostsFromActivity([
      activity({ id: "r1", eventType: "trip_plan_changed", payload: { cabin: "economy" } })
    ])[0]).toMatchObject({
      author: "traveller",
      body: "Updated the trip plan.",
      kind: "event"
    });
  });

  it("falls back to agent-voice lines for quiet checkpoints", () => {
    expect(activityFeedLine("trip_leg_flight_unselected")).toBe("Stopped watching a flight.");
    expect(feedPostsFromActivity([
      activity({ id: "a2", eventType: "trip_leg_flight_unselected" })
    ])).toEqual([
      expect.objectContaining({ body: "Stopped watching a flight.", author: "traveller" })
    ]);
  });
});

describe("trip checkpoint writes", () => {
  it("records the exact Telegram text as a captain_update checkpoint", async () => {
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
    expect(feedPostsFromActivity(feed).map((post) => post.body)).not.toContain(body);
    expect(feedPostsFromActivity(feed).map((post) => post.eventType)).toContain("trip_tracking_started");
  });

  it("does not mirror freeform assistant chat onto the trip feed", async () => {
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

    await store.appendMessage(
      owner.id,
      "assistant",
      "Itinerary ready to confirm.\n\nLOS → CDG",
      now
    );

    const feed = await store.listTripActivity(owner.id, created.trip.id);
    expect(feed.some((item) => item.eventType === "telegram_message")).toBe(false);
    expect(feedPostsFromActivity(feed).some((post) => post.body.includes("Itinerary ready"))).toBe(false);
  });

  it("emits plan_changed checkpoint + Telegram ack for material brief updates", async () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 44,
      telegramChatId: 44,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → LHR",
      brief: defaultTestBrief()
    });
    await service.update(owner.id, created.trip.id, {
      expectedVersion: created.trip.version,
      brief: defaultTestBrief({
        destinationAirports: ["CDG"],
        currency: "EUR",
        maximumPrice: 850
      })
    });

    const activity = await store.listTripActivity(owner.id, created.trip.id);
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "trip_plan_changed" })
    ]));
    expect(activity.some((item) => item.eventType === "trip_brief_updated")).toBe(false);

    const pending = await store.listPendingNotifications(now, 10);
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tripId: created.trip.id,
        kind: "plan_changed",
        payload: expect.objectContaining({
          tripRoute: "LHR → CDG and back",
          checkpointKey: `${created.trip.id}:plan_changed:2`
        })
      })
    ]));
  });

  it("enqueues pause ack notifications from the checkpoint", async () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const store = new MemoryCaptainPlatformStore();
    const owner = await store.ensureTelegramUser({
      telegramUserId: 45,
      telegramChatId: 45,
      username: null,
      firstName: "Ada",
      lastName: null
    }, now);
    const service = new TripService({ store, now: () => now });
    const created = await service.create(owner.id, {
      title: "LOS → LHR",
      brief: defaultTestBrief()
    });
    const tracked = await service.action(owner.id, created.trip.id, {
      type: "track",
      expectedVersion: created.trip.version
    });
    await store.listPendingNotifications(now, 10);
    await service.action(owner.id, created.trip.id, {
      type: "pause",
      expectedVersion: tracked.version
    });

    const pending = await store.listPendingNotifications(now, 10);
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tripId: created.trip.id,
        kind: "tracking_paused",
        payload: expect.objectContaining({
          checkpointKey: `${created.trip.id}:trip_pause:3`
        })
      })
    ]));
  });
});
