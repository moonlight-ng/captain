import { describe, expect, it } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { TripPlanningService } from "../services/trip-planning/service.js";
import { TripService } from "../services/trips/service.js";

const now = new Date("2026-08-09T08:00:00Z");

async function prepare(request: string, userNumber: number) {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: userNumber,
    telegramChatId: userNumber,
    username: null,
    firstName: "Website",
    lastName: "Test"
  }, now);
  const trips = new TripService({ store, now: () => now });
  const planning = new TripPlanningService({
    store,
    trips,
    apiKey: null,
    now: () => now,
    dashboardUrlForTrip: () => "https://captain.example/trip"
  });
  return planning.prepare(user.id, request);
}

describe("website flight-intelligence examples", () => {
  it("composes New York → Berlin → Lisbon without dropping the second stop", async () => {
    const result = await prepare(
      "Conference in Berlin on the 12th, then a weekend in Lisbon on the 18th — flying from New York.",
      101
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state).toMatchObject({
      tripType: "multi_city",
      legs: [
        {
          originAirports: ["NYC"], destinationAirports: ["BER"],
          departure: { start: "2026-08-09", end: "2026-08-12" },
          arriveBy: "2026-08-12"
        },
        {
          originAirports: ["BER"], destinationAirports: ["LIS"],
          departure: { start: "2026-08-13", end: "2026-08-18" },
          arriveBy: "2026-08-18"
        }
      ]
    });
  });

  it("keeps both cities and proposes a current seven-day Tokyo → Singapore market window", async () => {
    const result = await prepare(
      "Tokyo to Singapore — what’s the price range looking like?",
      102
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state.legs).toMatchObject([{
      originAirports: ["TYO"], destinationAirports: ["SIN"],
      departure: { start: "2026-08-09", end: "2026-08-15" }
    }]);
  });

  it("turns the first week of May into the complete seven-day SFO → NYC window", async () => {
    const result = await prepare(
      "San Francisco to New York in the first week of May — cheapest day in that window?",
      103
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state.legs).toMatchObject([{
      originAirports: ["SFO"], destinationAirports: ["NYC"],
      departure: { start: "2027-05-01", end: "2027-05-07" }
    }]);
  });

  it("anchors next week and weekday deadlines for Chicago → London → Barcelona", async () => {
    const result = await prepare(
      "Need to be in London before Wednesday, then Barcelona by Friday — starting from Chicago next week.",
      104
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state).toMatchObject({
      tripType: "multi_city",
      legs: [
        {
          originAirports: ["ORD"], destinationAirports: ["LON"],
          departure: { start: "2026-08-10", end: "2026-08-12" },
          arriveBy: "2026-08-12"
        },
        {
          originAirports: ["LON"], destinationAirports: ["BCN"],
          departure: { start: "2026-08-13", end: "2026-08-14" },
          arriveBy: "2026-08-14"
        }
      ]
    });
  });
});

describe("additional flight-intelligence scenarios", () => {
  it("preserves a repeated city as the final destination", async () => {
    const result = await prepare(
      "Fly from Lagos to New York on September 2 2026, then London on September 8 2026, back to New York on September 12 2026.",
      105
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state).toMatchObject({
      tripType: "multi_city",
      legs: [
        { originAirports: ["LOS"], destinationAirports: ["NYC"], departure: { date: "2026-09-02" } },
        { originAirports: ["NYC"], destinationAirports: ["LON"], departure: { date: "2026-09-08" } },
        { originAirports: ["LON"], destinationAirports: ["NYC"], departure: { date: "2026-09-12" } }
      ]
    });
  });

  it("derives two relative city deadlines from a next-week origin", async () => {
    const result = await prepare(
      "Starting in Lagos next week, need to be in London by Wednesday and Paris by Saturday.",
      106
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state.legs).toMatchObject([
      {
        originAirports: ["LOS"], destinationAirports: ["LON"],
        departure: { start: "2026-08-10", end: "2026-08-12" }
      },
      {
        originAirports: ["LON"], destinationAirports: ["PAR"],
        departure: { start: "2026-08-13", end: "2026-08-15" }
      }
    ]);
  });

  it("keeps the window, nonstop cabin, and four-digit budget together", async () => {
    const result = await prepare(
      "Tokyo to London September 3–7 2026, nonstop, premium economy, under $1,200.",
      107
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected a complete trip draft");
    expect(result.draft.state).toMatchObject({
      legs: [{
        originAirports: ["TYO"], destinationAirports: ["LON"],
        departure: { start: "2026-09-03", end: "2026-09-07" }
      }],
      cabin: "premium_economy",
      maxStops: 0,
      maximumPrice: 1200
    });
  });
});
