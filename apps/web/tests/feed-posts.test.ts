import { describe, expect, it } from "vitest";

import type { TripActivity } from "../src/domain.js";
import {
  activityFeedLine,
  feedPostAuthor,
  feedPostsFromActivity,
  legFlightSelectionFeedTitle
} from "../src/feed-posts.js";

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

  it("attributes flight selection by selectedBy, defaulting legacy rows to traveller", () => {
    expect(feedPostsFromActivity([
      activity({
        id: "agent",
        eventType: "trip_leg_flight_selected",
        payload: { legId: "leg-1", selectedBy: "agent" }
      }),
      activity({
        id: "person",
        eventType: "trip_leg_flight_selected",
        payload: { legId: "leg-1", selectedBy: "person" }
      }),
      activity({
        id: "legacy",
        eventType: "trip_leg_flight_selected",
        payload: { legId: "leg-1" }
      })
    ]).map((post) => [post.id, post.author])).toEqual([
      ["agent", "captain"],
      ["person", "traveller"],
      ["legacy", "traveller"]
    ]);
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

describe("legFlightSelectionFeedTitle", () => {
  const ba = {
    airlineCode: "BA",
    flightNumber: "BA178",
    departureDate: "2026-11-05",
    stops: 1,
    durationMinutes: 800,
    priceAmount: "842",
    currency: "USD"
  };
  const jl = {
    airlineCode: "JL",
    flightNumber: "JL5",
    departureDate: "2026-11-06",
    stops: 0,
    durationMinutes: 780,
    priceAmount: "791",
    currency: "USD"
  };

  it("describes a first selection with flight details", () => {
    expect(legFlightSelectionFeedTitle({
      eventType: "trip_leg_flight_selected",
      routeLabel: "Tokyo → New York",
      flight: ba
    })).toBe("Selected BA178 for Tokyo → New York — Nov 5 · $842 · 1 stop.");
  });

  it("describes a swap with previous flight diffs", () => {
    expect(legFlightSelectionFeedTitle({
      eventType: "trip_leg_flight_selected",
      routeLabel: "Tokyo → New York",
      flight: jl,
      previousFlight: ba,
      previousFlightKey: "ba-key"
    })).toBe("Changed Tokyo → New York to JL5 — Nov 6 · $791 · direct (was BA178 · $842 · 1 stop).");
  });

  it("describes an unselect with the previous flight identity", () => {
    expect(legFlightSelectionFeedTitle({
      eventType: "trip_leg_flight_unselected",
      routeLabel: "Tokyo → New York",
      flight: ba
    })).toBe("Stopped watching BA178 on Tokyo → New York.");
  });
});
