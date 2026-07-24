import { describe, expect, it } from "vitest";

import { TripLimitError } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import {
  isCaptainGreeting,
  parseTripPlanCallback
} from "../agent/channels/telegram.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
import {
  formatTripList,
  telegramDashboardMessage
} from "../services/trip-planning/format.js";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

const now = new Date("2025-07-01T12:00:00Z");

async function setup() {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: 42,
    telegramChatId: 42,
    username: null,
    firstName: "Ada",
    lastName: null
  }, now);
  const trips = new TripService({ store, liveMode: false, now: () => now });
  const planning = new TripPlanningService({
    store,
    trips,
    liveMode: false,
    apiKey: null,
    now: () => now,
    dashboardUrlForTrip: (_userId, tripId) =>
      `https://captain.example/t#test-${tripId}`
  });
  return { store, user, trips, planning };
}

describe("Captain Trip planning", () => {
  it("parses revision-bound Telegram confirmation buttons", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseTripPlanCallback(`captain-trip:start:${id}:3`)).toEqual({
      type: "start",
      draftId: id,
      revision: 3
    });
    expect(parseTripPlanCallback(`captain-trip:start:${id}:0`)).toBeNull();
  });

  it("routes only standalone greetings away from conversational history", () => {
    expect(isCaptainGreeting("Hi there")).toBe(true);
    expect(isCaptainGreeting("Good morning!")).toBe(true);
    expect(isCaptainGreeting("Hi, plan a Trip to New York")).toBe(false);
    expect(isCaptainGreeting("Where is my Trip?")).toBe(false);
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
    expect(second.draft.plan?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureWindow: { start: "2025-08-17", end: "2025-08-17" },
      stayNights: { minimum: 7, preferred: 7, maximum: 7 },
      travellers: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxStops: 1,
      currency: "NGN"
    });
    expect(second.confirmation).toContain("Sunday, 17 Aug 2025");
    expect(second.confirmation).toContain("Sunday, 24 Aug 2025");
    expect(second.confirmation).toContain("At most 1 stop (default)");

    const started = await planning.confirm(user.id, second.draft.id, second.draft.revision);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected started Trip");
    expect(started.receipt).toMatchObject({
      created: true,
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureDate: "2025-08-17",
      returnDate: "2025-08-24",
      stayNights: 7
    });
    expect(started.message).toContain("Send /trips");
    expect(started.message).toContain(`Open dashboard: https://captain.example/t#test-${started.receipt.tripId}`);
    await expect(planning.groundAssistantMessage(user.id, started.message))
      .resolves.toBe(started.message);
    await expect(planning.groundAssistantMessage(
      user.id,
      `Your Trip has been set up. Trip reference: ${started.receipt.tripId}`
    )).resolves.toBe("I couldn’t verify a Trip-creation receipt. Send /trips to check your Trips.");
    await expect(planning.groundAssistantMessage(user.id, "Your Trip has been set up."))
      .resolves.toBe("I couldn’t verify a Trip-creation receipt. Send /trips to check your Trips.");
    for (const greeting of [
      "Hi there! I can help you get started planning a Trip. Where would you like to go?",
      "Let’s get your Trip started. Where are you flying from?",
      "I can help you set up a Trip whenever you’re ready."
    ]) {
      await expect(planning.groundAssistantMessage(user.id, greeting)).resolves.toBe(greeting);
    }

    const retried = await planning.confirm(user.id, second.draft.id, second.draft.revision);
    expect(retried.status).toBe("started");
    if (retried.status !== "started") throw new Error("Expected idempotent result");
    expect(retried.receipt.created).toBe(false);
    expect(await trips.list(user.id)).toHaveLength(1);
  });

  it("prepares and starts a Lagos to New York to London multi-city Trip", async () => {
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
    expect(ready.draft.plan?.input).toMatchObject({
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

    const started = await planning.confirm(user.id, ready.draft.id, ready.draft.revision);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected started Trip");
    expect(started.receipt.legs).toHaveLength(2);
    expect(started.message).toContain("LOS → NYC → LON");
    const saved = await trips.list(user.id);
    expect(saved[0]?.brief.tripType).toBe("multi_city");
    expect(formatTripList(
      saved,
      (tripId) => `https://captain.example/t#fresh-${tripId}`
    )).toBe(
      `• LOS → NYC → LON · 16–23 Aug 2025\n  https://captain.example/t#fresh-${started.receipt.tripId}`
    );
    expect(telegramDashboardMessage(formatTripList(
      saved,
      (tripId) => `https://captain.example/t#fresh-${tripId}`
    ))).toEqual({
      text: "• LOS → NYC → LON · 16–23 Aug 2025",
      links: [{
        text: "Open LOS → NYC → LON",
        url: `https://captain.example/t#fresh-${started.receipt.tripId}`
      }]
    });
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

  it("clarifies weekday conflicts and never creates the inconsistent Trip", async () => {
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
    expect(revised.status).toBe("needs_input");
    if (revised.status !== "needs_input") throw new Error("Expected date clarification");
    expect(revised.prompt).toContain("return date must be after");
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

  it("restores the same confirmation revision after creation fails", async () => {
    const { planning, store, trips, user } = await setup();
    for (const [index, destination] of ["LHR", "PAR", "TYO"].entries()) {
      await trips.create(user.id, {
        title: `Existing ${index + 1}`,
        brief: defaultTestBrief({
          originAirports: ["LOS"],
          destinationAirports: [destination!],
          departureWindow: {
            start: `2026-09-0${index + 1}`,
            end: `2026-09-0${index + 1}`
          }
        }),
        cadenceHours: 6
      });
    }
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    await expect(planning.confirm(user.id, ready.draft.id, ready.draft.revision))
      .rejects.toBeInstanceOf(TripLimitError);
    await expect(store.getTripPlanDraft(user.id, ready.draft.id, now)).resolves.toMatchObject({
      status: "awaiting_confirmation",
      revision: ready.draft.revision,
      tripId: null
    });
    expect(await trips.list(user.id)).toHaveLength(3);
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
      liveMode: false,
      apiKey: null,
      now: () => now,
      dashboardUrlForTrip: (_userId, tripId) =>
        `https://captain.example/t#resumed-${tripId}`
    });
    const ready = await resumed.prepare(user.id, "Lagos just me", null, first.draft.id);
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.id).toBe(first.draft.id);
    expect(ready.draft.plan?.returnDate).toBe("2025-08-24");
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
    expect(await planning.activeTripLocation(user.id)).toContain("Send /trips");

    const next = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to London on August 20 2025 for one adult."
    );
    if (next.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const cancelled = await planning.cancel(user.id, next.draft.id, next.draft.revision);
    expect(cancelled.status).toBe("cancelled");
  });
});
