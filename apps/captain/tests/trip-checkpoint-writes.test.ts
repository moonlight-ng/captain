import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

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
      }),
      expect.objectContaining({ eventType: "trip_tracking_started" })
    ]));
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
    expect(feed.some((item) => (item.body ?? "").includes("Itinerary ready"))).toBe(false);
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
