import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import {
  hasDeliveredTripConfirmation,
  isCaptainGreeting,
  parseTripPlanCallback,
  tripPlanConfirmationReplyMarkup
} from "../agent/channels/telegram.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
import {
  telegramDashboardMessage
} from "../services/trip-planning/format.js";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

const now = new Date("2025-07-01T12:00:00Z");

async function setup(clock = now) {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: 42,
    telegramChatId: 42,
    username: null,
    firstName: "Ada",
    lastName: null
  }, now);
  const trips = new TripService({ store, now: () => clock });
  const planning = new TripPlanningService({
    store,
    trips,
    apiKey: null,
    now: () => clock,
    dashboardUrlForTrip: (_userId, tripId) =>
      `https://captain.example/t#test-${tripId}`
  });
  return { store, user, trips, planning };
}

describe("Captain trip planning", () => {
  it("parses revision-bound Telegram confirmation buttons", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(tripPlanConfirmationReplyMarkup({ id, revision: 3 })).toEqual({
      inline_keyboard: [[{
        text: "Create",
        callback_data: `captain-trip:start:${id}:3`
      }, {
        text: "Cancel",
        callback_data: `captain-trip:cancel:${id}:3`
      }]]
    });
    expect(parseTripPlanCallback(`captain-trip:start:${id}:3`)).toEqual({
      type: "start",
      draftId: id,
      revision: 3
    });
    expect(parseTripPlanCallback(`captain-trip:start:${id}:0`)).toBeNull();
  });

  it("distinguishes a delivered confirmation from an older button message", () => {
    const draft = { updatedAt: "2026-09-01T12:00:00.000Z" };
    expect(hasDeliveredTripConfirmation(draft, "Ready", [{
      role: "assistant",
      content: "Ready",
      createdAt: "2026-09-01T11:59:59.000Z"
    }])).toBe(false);
    expect(hasDeliveredTripConfirmation(draft, "Ready", [{
      role: "assistant",
      content: "Ready",
      createdAt: "2026-09-01T12:00:01.000Z"
    }])).toBe(true);
  });

  it("routes only standalone greetings away from conversational history", () => {
    expect(isCaptainGreeting("Hi there")).toBe(true);
    expect(isCaptainGreeting("Good morning!")).toBe(true);
    expect(isCaptainGreeting("Hi, plan a trip to New York")).toBe(false);
    expect(isCaptainGreeting("Where is my trip?")).toBe(false);
  });

  it("reproduces the Lagos-to-New-York conversation without changing dates", async () => {
    const { planning, trips, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Set up a round trip from home to New York for the week starting Sunday, August 17 and back Sunday the following week."
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected a clarification");
    expect(first.missingFields).toContain("originAirports");
    expect(first.missingFields).not.toContain("travellers");
    expect(first.prompt).toContain("Where are you flying from");

    const second = await planning.prepare(user.id, "Lagos just me", null, first.draft.id);
    expect(second.status).toBe("awaiting_confirmation");
    if (second.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(second.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureWindow: { start: "2025-08-17", end: "2025-08-17" },
      stayNights: { minimum: 7, preferred: 7, maximum: 7 },
      travellers: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxStops: 2,
      currency: "USD"
    });
    expect(second.confirmation).toContain("Sunday, 17 Aug 2025");
    expect(second.confirmation).toContain("Sunday, 24 Aug 2025");
    expect(second.confirmation).toContain("At most 2 stops (default)");

    const started = await planning.confirm(user.id, second.draft.id, second.draft.revision);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected started trip");
    expect(started.receipt).toMatchObject({
      created: true,
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureDate: "2025-08-17",
      returnDate: "2025-08-24",
      stayNights: 7
    });
    expect(started.message).toContain("Send /trips");
    expect(started.message).toContain(`Open trip: https://captain.example/t#test-${started.receipt.tripId}`);
    expect(started.message).not.toContain("Trip reference");
    const renderedReceipt = telegramDashboardMessage(started.message);
    expect(renderedReceipt.text).not.toContain("Trip reference");
    expect(renderedReceipt.text).not.toContain(started.receipt.tripId);
    await expect(planning.groundAssistantMessage(user.id, started.message))
      .resolves.toEqual({ message: started.message, createdTrip: true });
    await expect(planning.groundAssistantMessage(
      user.id,
      `Your trip has been set up. trip reference: ${started.receipt.tripId}`
    )).resolves.toEqual({
      message: "I couldn’t verify a trip-creation receipt. Send /trips to check your trips.",
      createdTrip: false
    });
    await expect(planning.groundAssistantMessage(user.id, "Your trip has been set up."))
      .resolves.toEqual({
        message: "I couldn’t verify a trip-creation receipt. Send /trips to check your trips.",
        createdTrip: false
      });
    for (const greeting of [
      "Hi there! I can help you get started planning a trip. Where would you like to go?",
      "Let’s get your trip started. Where are you flying from?",
      "I can help you set up a trip whenever you’re ready."
    ]) {
      await expect(planning.groundAssistantMessage(user.id, greeting)).resolves.toEqual({
        message: greeting,
        createdTrip: false
      });
    }

    const retried = await planning.confirm(user.id, second.draft.id, second.draft.revision);
    expect(retried.status).toBe("started");
    if (retried.status !== "started") throw new Error("Expected idempotent result");
    expect(retried.receipt.created).toBe(false);
    expect(await trips.list(user.id)).toHaveLength(1);
  });

  it("prepares and starts a Lagos to New York to London multi-city trip", async () => {
    const { planning, trips, user } = await setup();
    expect(TripPlanningService.isTripPlanningRequest(
      "What are the best options to fly from Lagos to New York and back to London from Aug 16 - 23?"
    )).toBe(true);
    const ready = await planning.prepare(
      user.id,
      "Find the best flights from Lagos to New York and back to London from Aug 16 - 23."
    );

    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.confirmationSnapshot?.input).toMatchObject({
      title: "LOS to NYC to LON",
      brief: {
        originAirports: ["LOS"],
        destinationAirports: ["LON"],
        tripType: "multi_city",
        stayNights: null,
        legs: [
          {
            originAirports: ["LOS"],
            destinationAirports: ["NYC"],
            departureWindow: { start: "2025-08-16", end: "2025-08-16" }
          },
          {
            originAirports: ["NYC"],
            destinationAirports: ["LON"],
            departureWindow: { start: "2025-08-23", end: "2025-08-23" }
          }
        ]
      }
    });
    expect(ready.confirmation).toContain("LOS → NYC → LON");
    expect(ready.confirmation).toContain("Travellers: 1 (default)");
    expect(ready.confirmation).toContain(
      "Tap Create or Cancel below, or reply with what you’d like to change."
    );

    const started = await planning.confirm(user.id, ready.draft.id, ready.draft.revision);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected started trip");
    expect(started.receipt.legs).toHaveLength(2);
    expect(started.message).toContain("LOS → NYC → LON");
    const saved = await trips.list(user.id);
    expect(saved[0]?.brief.tripType).toBe("multi_city");
    expect(telegramDashboardMessage(
      `Trip saved\nOpen trip: https://captain.example/t#fresh-${started.receipt.tripId}`
    )).toEqual({
      text: "Trip saved",
      links: [{
        text: "Open trip",
        url: `https://captain.example/t#fresh-${started.receipt.tripId}`
      }]
    });
  });

  it("binds every date to its own leg in a longer multi-city trip", async () => {
    const { planning, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Fly from Lagos to New York on Aug 17, to London on the 20th, to Paris on the 23rd"
    );
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.confirmationSnapshot?.input.brief.legs).toEqual([
      expect.objectContaining({
        originAirports: ["LOS"],
        destinationAirports: ["NYC"],
        departureWindow: { start: "2025-08-17", end: "2025-08-17" }
      }),
      expect.objectContaining({
        originAirports: ["NYC"],
        destinationAirports: ["LON"],
        departureWindow: { start: "2025-08-20", end: "2025-08-20" }
      }),
      expect.objectContaining({
        originAirports: ["LON"],
        destinationAirports: ["PAR"],
        departureWindow: { start: "2025-08-23", end: "2025-08-23" }
      })
    ]);
  });

  it("coalesces concurrent confirmations into one created and one reused receipt", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const results = await Promise.all([
      planning.confirm(user.id, ready.draft.id, ready.draft.revision),
      planning.confirm(user.id, ready.draft.id, ready.draft.revision)
    ]);
    expect(results.map((result) => result.status)).toEqual(["started", "started"]);
    const created = results.map((result) => result.status === "started" && result.receipt.created);
    expect(created.sort()).toEqual([false, true]);
    expect(await trips.list(user.id)).toHaveLength(1);
  });

  it("clarifies weekday conflicts and never creates the inconsistent trip", async () => {
    const { planning, trips, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Create a round trip from Lagos to New York departing Sunday August 17 2026 and returning Sunday August 24 2026 for one adult."
    );
    expect(result.status).toBe("needs_input");
    if (result.status !== "needs_input") throw new Error("Expected date clarification");
    expect(result.prompt).toContain("Monday, not Sunday");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("resolves a relative departure and defaults an unspecified trip to one-way", async () => {
    const { planning, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Lagos to Anambra this Saturday"
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["ANA"],
      tripType: "one_way",
      departureWindow: { start: "2025-07-05", end: "2025-07-05" },
      maxStops: 1,
      currency: "USD"
    });
  });

  it("understands an implied-origin return and inherits the month for the second leg", async () => {
    const clock = new Date("2026-07-27T06:23:00Z");
    const { planning, user } = await setup(clock);
    const result = await planning.prepare(
      user.id,
      "Let's track a trip to New York on Aug 17. Return to London on the 23"
    );

    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LON"],
      destinationAirports: ["NYC"],
      tripType: "round_trip",
      departureWindow: { start: "2026-08-17", end: "2026-08-17" },
      stayNights: { minimum: 6, preferred: 6, maximum: 6 }
    });
    expect(result.confirmation).toContain("LON → NYC");
    expect(result.confirmation).toContain("Monday, 17 Aug 2026");
    expect(result.confirmation).toContain("Sunday, 23 Aug 2026");
    expect(result.draft.state.legs).toMatchObject([
      { originAirports: ["LON"], destinationAirports: ["NYC"] },
      { originAirports: ["NYC"], destinationAirports: ["LON"] }
    ]);
  });

  it("scopes a follow-up to the pending return leg without overwriting departure", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a round trip from Lagos to New York on Aug 17"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected a return-date question");
    expect(first.missingFields).toContain("returnDate");

    const completed = await planning.prepare(
      user.id,
      "Aug 23 to Lagos",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("awaiting_confirmation");
    if (completed.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      returnDate: "2025-08-23"
    });
    expect(completed.draft.state.legs.map((leg) => leg.departure)).toEqual([
      { kind: "exact", date: "2025-08-17" },
      { kind: "exact", date: "2025-08-23" }
    ]);
  });

  it("applies only the route and date operations expressed by a follow-up", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on Aug 17"
    );
    expect(first.status).toBe("awaiting_confirmation");
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const attemptedRewrite = await planning.prepare(
      user.id,
      "Aug 23 to London",
      null,
      first.draft.id
    );
    expect(attemptedRewrite.status).toBe("awaiting_confirmation");
    if (attemptedRewrite.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(attemptedRewrite.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-23",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("applies a targeted correction without erasing unrelated explicit facts", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on Aug 17"
    );
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const corrected = await planning.prepare(
      user.id,
      "Actually, make the destination London",
      null,
      first.draft.id
    );
    expect(corrected.status).toBe("awaiting_confirmation");
    if (corrected.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(corrected.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("does not reconstruct missing facts from conversation history", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected an origin question");
    expect(first.prompt).toBe("Where are you flying from?");

    const repair = await planning.prepare(
      user.id,
      "It's in the message",
      null,
      first.draft.id
    );
    expect(repair.status).toBe("needs_input");
    if (repair.status !== "needs_input") throw new Error("Expected a repaired clarification");
    expect(repair.prompt).toBe(first.prompt);
    expect(repair.draft.state).toEqual(first.draft.state);
  });

  it("does not let an open draft consume an unrelated Telegram message", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    if (first.status !== "needs_input") throw new Error("Expected an origin question");

    await expect(planning.handleOpenDraftText(
      user.id,
      "What can you help me with?",
      null
    )).resolves.toBeNull();
    const unchanged = await planning.findOpen(user.id);
    expect(unchanged?.revision).toBe(first.draft.revision);
  });

  it("starts an explicitly new draft instead of forcing it into the open one", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    if (first.status !== "needs_input") throw new Error("Expected an origin question");

    const replacement = await planning.handleOpenDraftText(
      user.id,
      "Track another trip from Lagos to London on Aug 20",
      null
    );
    expect(replacement?.status).toBe("awaiting_confirmation");
    if (replacement?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(replacement.draft.id).not.toBe(first.draft.id);
    expect(replacement.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-20",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("replaces a stale draft when a complete track directive is repeated", async () => {
    const clock = new Date("2026-07-27T06:23:00Z");
    const { planning, user } = await setup(clock);
    const stale = await planning.prepare(
      user.id,
      "Track a round trip from New York to London on Aug 23"
    );
    expect(stale.status).toBe("needs_input");
    if (stale.status !== "needs_input") throw new Error("Expected an open stale draft");

    const replacement = await planning.handleOpenDraftText(
      user.id,
      "Let's track a trip to New York on Aug 17. Return to London on the 23",
      null
    );
    expect(replacement?.status).toBe("awaiting_confirmation");
    if (replacement?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(replacement.draft.id).not.toBe(stale.draft.id);
    expect(replacement.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-08-17",
      returnDate: "2026-08-23",
      input: {
        brief: {
          originAirports: ["LON"],
          destinationAirports: ["NYC"],
          tripType: "round_trip"
        }
      }
    });
  });

  it("keeps route context and resolves a next-day return across follow-up turns", async () => {
    const clock = new Date("2026-07-27T07:55:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Let's do another trip to Abuja this Sunday"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected an origin question");
    expect(first.prompt).toBe("Where are you flying from?");

    const completed = await planning.prepare(
      user.id,
      "Lagos as well. Return to Lagos next day",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("awaiting_confirmation");
    if (completed.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-08-02",
      returnDate: "2026-08-03",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["ABV"],
          tripType: "round_trip"
        }
      }
    });

    const repaired = await planning.prepare(
      user.id,
      "I said return to Lagos next day",
      null,
      completed.draft.id
    );
    expect(repaired.status).toBe("awaiting_confirmation");
    if (repaired.status !== "awaiting_confirmation") throw new Error("Expected repaired confirmation");
    expect(repaired.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-08-02",
      returnDate: "2026-08-03",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["ABV"],
          tripType: "round_trip"
        }
      }
    });
  });

  it("inherits the month when answering with an ordinal weekday", async () => {
    const clock = new Date("2026-07-29T00:00:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Check for Lagos to London first week of September"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected a departure-date question");
    expect(first.prompt).toBe(
      "Which exact departure date should I use within 2026-09-01 to 2026-09-07?"
    );

    const completed = await planning.prepare(
      user.id,
      "The first Sunday",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("awaiting_confirmation");
    if (completed.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-09-06",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"],
          tripType: "one_way"
        }
      }
    });
  });

  it("applies an explicit ordinal-weekday date correction", async () => {
    const clock = new Date("2026-07-29T00:00:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Check for Lagos to London on August 2"
    );
    expect(first.status).toBe("awaiting_confirmation");
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const corrected = await planning.prepare(
      user.id,
      "First Sunday September not August",
      null,
      first.draft.id
    );
    expect(corrected.status).toBe("awaiting_confirmation");
    if (corrected.status !== "awaiting_confirmation") throw new Error("Expected corrected confirmation");
    expect(corrected.draft.confirmationSnapshot?.departureDate).toBe("2026-09-06");
  });

  it("does not silently create a multi-traveller trip in the one-adult beta", async () => {
    const { planning, trips, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for two adults."
    );
    expect(result.status).toBe("needs_input");
    if (result.status !== "needs_input") throw new Error("Expected one-adult clarification");
    expect(result.prompt).toContain("exactly one adult");
    expect(result.missingFields).toContain("travellers");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("rejects a return-date revision that moves before the preserved departure", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a round trip from Lagos to New York departing August 17 2025 and returning August 24 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const revised = await planning.prepare(
      user.id,
      "Return August 10 2025 instead.",
      null,
      ready.draft.id
    );
    expect(revised.status).toBe("awaiting_confirmation");
    if (revised.status !== "awaiting_confirmation") throw new Error("Expected retained confirmation");
    expect(revised.confirmation).toContain("return date must be after");
    expect(revised.confirmation).toContain("I kept the previous dates");
    expect(revised.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      returnDate: "2025-08-24"
    });
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("rejects stale confirmation revisions", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const revised = await planning.prepare(
      user.id,
      "Make it business class.",
      null,
      ready.draft.id
    );
    if (revised.status !== "awaiting_confirmation") throw new Error("Expected revised confirmation");

    await expect(planning.confirm(user.id, ready.draft.id, ready.draft.revision))
      .rejects.toThrow("stale");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("tracks a different confirmed trip alongside the current trip", async () => {
    const { planning, trips, user } = await setup();
    const current = await trips.create(user.id, {
      title: "Existing London trip",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["LHR"],
        tripType: "one_way",
        stayNights: null
      }),
      cadenceHours: 6,
      trackingDurationHours: 72
    });
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.confirmation).not.toContain("archive");
    const added = await planning.confirm(user.id, ready.draft.id, ready.draft.revision);
    expect(added.status).toBe("started");
    if (added.status !== "started") throw new Error("Expected started trip");
    const saved = await trips.list(user.id);
    expect(saved).toHaveLength(2);
    expect(saved.find((trip) => trip.id === current.trip.id)).toMatchObject({
      status: "tracking",
      archiveReason: null
    });
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: current.trip.id, status: "tracking" }),
      expect.objectContaining({ id: added.receipt.tripId, status: "tracking" })
    ]));
  });

  it("keeps the open draft across a fresh planning-service session", async () => {
    const { planning, store, trips, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Set up a round trip from home to New York starting Sunday August 17 2025 and back Sunday the following week."
    );
    if (first.status !== "needs_input") throw new Error("Expected clarification");
    const resumed = new TripPlanningService({
      store,
      trips,
      apiKey: null,
      now: () => now,
      dashboardUrlForTrip: (_userId, tripId) =>
        `https://captain.example/t#resumed-${tripId}`
    });
    const ready = await resumed.prepare(user.id, "Lagos just me", null, first.draft.id);
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.id).toBe(first.draft.id);
    expect(ready.draft.confirmationSnapshot?.returnDate).toBe("2025-08-24");
  });

  it("supports typed confirmation, cancellation, edits, and grounded Where replies", async () => {
    const { planning, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const started = await planning.handleOpenDraftText(user.id, "Yes", null);
    expect(started?.status).toBe("started");
    expect(await planning.activeTripLocation(user.id)).toBe(
      "Your trip is tracking.\n\n"
      + "• LOS → NYC\n"
      + "• Depart: Sunday, 17 Aug 2025\n"
      + "• 1 traveller, Economy, At most 2 stops, USD\n\n"
      + `Open trip: https://captain.example/t#test-${started?.status === "started" ? started.receipt.tripId : ""}`
    );

    const next = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to London on August 20 2025 for one adult."
    );
    if (next.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const revised = await planning.handleOpenDraftText(
      user.id,
      "Change the departure to August 21 2025",
      null
    );
    expect(revised?.status).toBe("awaiting_confirmation");
    if (revised?.status !== "awaiting_confirmation") throw new Error("Expected revised confirmation");
    expect(revised.draft.confirmationSnapshot?.departureDate).toBe("2025-08-21");
    const cancelled = await planning.cancel(user.id, revised.draft.id, revised.draft.revision);
    expect(cancelled.status).toBe("cancelled");
  });

  it("turns Telegram into the selector when several trips are active", async () => {
    const { planning, trips, user } = await setup();
    const anambra = await trips.create(user.id, {
      title: "Anambra",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["ANA"],
        departureWindow: { start: "2025-08-01", end: "2025-08-01" },
        currency: "NGN"
      }),
      cadenceHours: 6,
      trackingDurationHours: 72
    });
    const london = await trips.create(user.id, {
      title: "London",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["LHR"],
        departureWindow: { start: "2025-09-01", end: "2025-09-01" },
        currency: "USD"
      }),
      cadenceHours: 6,
      trackingDurationHours: 72
    });

    const message = await planning.activeTripsLocation(user.id);
    expect(message).toContain("You’re tracking 2 trips:");
    expect(message).toContain("• LOS → ANA");
    expect(message).toContain("• LOS → LHR");
    const rendered = telegramDashboardMessage(message!);
    expect(rendered.links).toEqual(expect.arrayContaining([
      {
        text: "Open LOS → ANA",
        url: `https://captain.example/t#test-${anambra.trip.id}`
      },
      {
        text: "Open LOS → LHR",
        url: `https://captain.example/t#test-${london.trip.id}`
      }
    ]));
    expect(rendered.text).not.toContain("https://");
  });
});
