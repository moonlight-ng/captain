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
    expect(window.status).toBe("awaiting_confirmation");
    if (window.status !== "awaiting_confirmation") throw new Error("Expected a window confirmation");
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
    expect(turn).toEqual({ intent: "unrelated", operations: [], unresolvedPlaces: [] });
  });
});

describe("Trip planner v3 reducer invariants", () => {
  const populated: TripDraftState = {
    version: 3,
    questionsAsked: 0,
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
    excludedAirlines: ["BA"],
    assumedAirports: []
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

  // The same window is not ambiguous once the traveller says which end they
  // mean. “Before” is the last Sunday that still lands in time; “after” is the
  // first one once the window opens.
  it.each([
    ["Sunday before", "2026-09-27"],
    ["Sunday after", "2026-09-06"]
  ])("resolves “%s” against the leg's window", (expression, expected) => {
    const state = structuredClone(populated);
    state.tripType = "one_way";
    state.legs = [state.legs[0]!];
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
          expression,
          evidence: expression
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(reduced.state.legs[0]!.departure).toEqual({ kind: "exact", date: expected });
  });

  // “The Sunday before” survives the trip from the traveller's words to the
  // reducer: dropping the direction on the way turned it back into a question.
  it("keeps the direction word on a weekday answer", () => {
    const turn = deterministicTripTurn({
      request: "The Sunday before",
      conversation: ["The Sunday before"],
      state: {
        ...structuredClone(populated),
        legs: [{
          originAirports: ["LOS"],
          destinationAirports: ["NBO"],
          departure: null,
          arriveBy: "2026-11-04",
          feasibleDepartureWindow: { start: "2026-08-08", end: "2026-11-03" },
          proposedDeparture: null
        }]
      },
      activeQuestion: "itineraryLegs",
      now: clock,
      timeZone: "UTC"
    });
    expect(turn.operations).toEqual([{
      type: "set_date",
      target: { field: "leg", legIndex: 0 },
      expression: "Sunday before",
      evidence: "Sunday before"
    }]);
  });

  // A failed save leaves the completed draft open. Repeating the answer with
  // punctuation must stay anchored to that leg instead of being re-read as
  // the next weekday after today.
  it("keeps a punctuated weekday retry anchored to the arrival deadline", () => {
    const state: TripDraftState = {
      ...structuredClone(populated),
      tripType: "one_way",
      legs: [{
        originAirports: ["LON"],
        destinationAirports: ["NBO"],
        departure: { kind: "exact", date: "2026-11-01" },
        arriveBy: "2026-11-04",
        feasibleDepartureWindow: { start: "2026-08-08", end: "2026-11-03" },
        proposedDeparture: null
      }]
    };
    const turn = deterministicTripTurn({
      request: "The Sunday before?",
      conversation: ["The Sunday before", "The Sunday before?"],
      state,
      activeQuestion: null,
      now: clock,
      timeZone: "UTC"
    });
    expect(turn.operations).toEqual([{
      type: "set_date",
      target: { field: "departure" },
      expression: "Sunday before",
      evidence: "Sunday before"
    }]);

    const reduced = applyTripTurnPatch({
      state,
      patch: turn,
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(reduced.state.legs[0]!.departure).toEqual({
      kind: "exact",
      date: "2026-11-01"
    });
  });
});

/**
 * A multi-city route is a chain: each leg leaves from where the previous one
 * landed. `validateMultiCityBrief` enforces this at the brief boundary, but a
 * draft that breaks it earlier turns a dropped city into a valid-looking
 * shorter trip instead of an error.
 */
function routeBreaks(legs: TripDraftState["legs"]): string[] {
  return legs.flatMap((leg, index) => {
    const next = legs[index + 1];
    if (!next) return [];
    const landed = new Set(leg.destinationAirports);
    return next.originAirports.some((code) => landed.has(code))
      ? []
      : [`${leg.destinationAirports.join("/")} → ${next.originAirports.join("/")}`];
  });
}

describe("route contiguity", () => {
  const chained: TripDraftState = {
    ...EMPTY_TRIP_DRAFT_STATE,
    legs: [
      { originAirports: ["LON"], destinationAirports: ["PAR"], departure: { kind: "exact", date: "2026-11-04" } },
      { originAirports: ["PAR"], destinationAirports: ["NYC"], departure: { kind: "exact", date: "2026-12-09" } }
    ]
  };

  it("holds when a route operation rewrites the whole chain", () => {
    const reduced = applyTripTurnPatch({
      state: chained,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_route",
          legs: [
            { originAirports: ["LON"], destinationAirports: ["PAR"] },
            { originAirports: ["PAR"], destinationAirports: ["MAD"] },
            { originAirports: ["MAD"], destinationAirports: ["LOS"] }
          ],
          evidence: "London to Paris to Madrid to Lagos"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(routeBreaks(reduced.state.legs)).toEqual([]);
  });

  it("holds when a date operation leaves the route alone", () => {
    const reduced = applyTripTurnPatch({
      state: chained,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_date",
          target: { field: "leg", legIndex: 1 },
          expression: "2026-12-10",
          evidence: "December 10"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(routeBreaks(reduced.state.legs)).toEqual([]);
  });

  // A dropped city leaves a gap rather than a shorter journey. Accepting this
  // is what let a lost Marseille pass as a London–Paris–New York trip.
  it("rejects a broken chain and keeps the state it had", () => {
    const reduced = applyTripTurnPatch({
      state: chained,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_route",
          legs: [
            { originAirports: ["LON"], destinationAirports: ["PAR"] },
            { originAirports: ["MRS"], destinationAirports: ["NYC"] }
          ],
          evidence: "London to Paris, Marseille to New York"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toContain("PAR → MRS");
    expect(reduced.appliedOperations).toEqual([]);
    expect(reduced.state.legs).toEqual(chained.legs);
  });

  it("keeps each flight's own date when a city is inserted mid-itinerary", () => {
    const threeLegs: TripDraftState = {
      ...EMPTY_TRIP_DRAFT_STATE,
      legs: [
        { originAirports: ["LON"], destinationAirports: ["PAR"], departure: { kind: "exact", date: "2026-11-04" } },
        { originAirports: ["PAR"], destinationAirports: ["NYC"], departure: { kind: "exact", date: "2026-12-09" } },
        { originAirports: ["NYC"], destinationAirports: ["LOS"], departure: { kind: "exact", date: "2026-12-20" } }
      ]
    };
    const reduced = applyTripTurnPatch({
      state: threeLegs,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_route",
          legs: [
            { originAirports: ["LON"], destinationAirports: ["PAR"] },
            { originAirports: ["PAR"], destinationAirports: ["MRS"] },
            { originAirports: ["MRS"], destinationAirports: ["NYC"] },
            { originAirports: ["NYC"], destinationAirports: ["LOS"] }
          ],
          evidence: "add Marseille between Paris and New York"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(reduced.state.legs).toHaveLength(4);
    // Inserting Marseille shifts every later leg along by one. Matching by
    // index left the new fourth leg — the flight to Lagos — with no date at
    // all; matching by route keeps 20 December on it.
    expect(reduced.state.legs[0]!.departure).toEqual({ kind: "exact", date: "2026-11-04" });
    expect(reduced.state.legs.at(-1)!.departure).toEqual({ kind: "exact", date: "2026-12-20" });
  });

  it("finds a leg it only knew half of once the other half arrives", () => {
    const halfKnown: TripDraftState = {
      ...EMPTY_TRIP_DRAFT_STATE,
      legs: [{
        originAirports: [],
        destinationAirports: ["NYC"],
        departure: { kind: "exact", date: "2026-08-17" }
      }]
    };
    const reduced = applyTripTurnPatch({
      state: halfKnown,
      patch: {
        intent: "continue",
        operations: [{
          type: "set_route",
          legs: [{ originAirports: ["LOS"], destinationAirports: ["NYC"] }],
          evidence: "Lagos"
        }]
      },
      now: clock,
      timeZone: "UTC"
    });
    expect(reduced.issue).toBeNull();
    expect(reduced.state.legs[0]!.departure).toEqual({ kind: "exact", date: "2026-08-17" });
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
