import { describe, expect, it } from "vitest";

import {
  EMPTY_TRIP_DRAFT_STATE,
  stableJson,
  type TripDraftState
} from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { applyTripTurnPatch } from "../services/trip-planning/draft-reducer.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
import {
  deterministicTripTurn,
  type TripTurnPatch
} from "../services/trip-planning/turn-interpreter.js";
import { TripService } from "../services/trips/service.js";

const clock = new Date("2026-07-31T08:00:00.000Z");

async function setup() {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: 100,
    telegramChatId: 100,
    username: null,
    firstName: "Ada",
    lastName: null
  }, clock);
  const trips = new TripService({ store, now: () => clock });
  const planning = new TripPlanningService({
    store,
    trips,
    apiKey: null,
    now: () => clock
  });
  return { planning, user };
}

describe("Trip planner v3 transcript", () => {
  it("stores a flexible window, resolves Sunday inside it, and normalizes sudnay", async () => {
    const { planning, user } = await setup();
    const window = await planning.prepare(
      user.id,
      "Lagos to london one way first week of September"
    );
    expect(window.status).toBe("needs_input");
    if (window.status !== "needs_input") throw new Error("Expected an exact-date question");
    expect(window.draft.state).toMatchObject({
      version: 3,
      tripType: "one_way",
      legs: [{
        originAirports: ["LOS"],
        destinationAirports: ["LON"],
        departure: {
          kind: "window",
          start: "2026-09-01",
          end: "2026-09-07",
          source: "first week of September"
        }
      }]
    });

    const sunday = await planning.prepare(user.id, "Sunday", null, window.draft.id);
    expect(sunday.status).toBe("awaiting_confirmation");
    if (sunday.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(sunday.draft.confirmationSnapshot?.departureDate).toBe("2026-09-06");

    const corrected = await planning.prepare(
      user.id,
      "First sudnay september i mean",
      null,
      sunday.draft.id
    );
    expect(corrected.status).toBe("awaiting_confirmation");
    if (corrected.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(corrected.draft.confirmationSnapshot?.departureDate).toBe("2026-09-06");
    expect(corrected.draft.state.legs[0]).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      departure: { kind: "exact", date: "2026-09-06" }
    });
  });

  it("returns an empty unrelated patch to the conversation agent", () => {
    const turn = deterministicTripTurn({
      request: "What can you help me with?",
      conversation: [],
      state: structuredClone(EMPTY_TRIP_DRAFT_STATE),
      activeQuestion: "departureDate",
      now: clock,
      timeZone: "UTC"
    });
    expect(turn).toEqual({ intent: "unrelated", operations: [] });
  });
});

describe("Trip planner v3 reducer invariants", () => {
  const populated: TripDraftState = {
    version: 3,
    tripType: "round_trip",
    legs: [{
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      departure: { kind: "exact", date: "2026-09-06" }
    }, {
      originAirports: ["LON"],
      destinationAirports: ["LOS"],
      departure: { kind: "exact", date: "2026-09-13" }
    }],
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 2,
    currency: "USD",
    maximumPrice: 900,
    preferredAirlines: ["AT"],
    excludedAirlines: ["BA"]
  };

  it.each<TripTurnPatch>([
    {
      intent: "continue",
      operations: [{
        type: "set_option",
        field: "cabin",
        value: "business",
        evidence: "business"
      }]
    },
    {
      intent: "continue",
      operations: [{
        type: "set_date",
        target: { field: "departure" },
        expression: "2026-09-07",
        evidence: "September 7"
      }]
    },
    {
      intent: "continue",
      operations: [{
        type: "set_route",
        legs: [{ originAirports: ["LOS"], destinationAirports: ["PAR"] }],
        evidence: "Lagos to Paris"
      }]
    }
  ])("never reduces populated state without an explicit clear", (patch) => {
    const reduced = applyTripTurnPatch({
      state: populated,
      patch,
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(populatedPaths(reduced.state)).toEqual(expect.arrayContaining(populatedPaths(populated)));
  });

  it("only an explicit clear removes a populated value", () => {
    const reduced = applyTripTurnPatch({
      state: populated,
      patch: {
        intent: "continue",
        operations: [{
          type: "clear",
          target: "maximumPrice",
          evidence: "remove the price limit"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.state.maximumPrice).toBeNull();
    expect(stableJson(reduced.state.legs)).toBe(stableJson(populated.legs));
  });

  it("retains an ambiguous window and asks for a targeted weekday choice", () => {
    const state = structuredClone(populated);
    state.legs[0]!.departure = {
      kind: "window",
      start: "2026-09-01",
      end: "2026-09-30",
      source: "September"
    };
    const reduced = applyTripTurnPatch({
      state,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_date",
          target: { field: "departure" },
          expression: "Sunday",
          evidence: "Sunday"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toContain("Which one should I use?");
    expect(reduced.state).toEqual(state);
  });
});

function populatedPaths(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => populatedPaths(item, `${prefix}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      populatedPaths(item, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [prefix];
}
