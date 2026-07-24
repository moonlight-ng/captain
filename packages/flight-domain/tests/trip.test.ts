import { describe, expect, it } from "vitest";

import { tripBriefSchema } from "../src/index.js";

const baseBrief = {
  originAirports: ["LOS"],
  destinationAirports: ["LON"],
  tripType: "multi_city" as const,
  departureWindow: { start: "2026-08-16", end: "2026-08-16" },
  stayNights: null,
  legs: [
    {
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureWindow: { start: "2026-08-16", end: "2026-08-16" }
    },
    {
      originAirports: ["NYC"],
      destinationAirports: ["LON"],
      departureWindow: { start: "2026-08-23", end: "2026-08-23" }
    }
  ],
  travellers: { adults: 1, childrenAges: [], infants: 0 },
  cabin: "economy" as const,
  maxStops: 1,
  currency: "GBP",
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: [],
  context: ""
};

describe("multi-city Trip briefs", () => {
  it("accepts a connected itinerary with exact dates", () => {
    expect(tripBriefSchema.parse(baseBrief).legs).toHaveLength(2);
  });

  it("rejects disconnected and reverse-ordered legs", () => {
    const result = tripBriefSchema.safeParse({
      ...baseBrief,
      legs: [
        baseBrief.legs[0],
        {
          originAirports: ["PAR"],
          destinationAirports: ["LON"],
          departureWindow: { start: "2026-08-10", end: "2026-08-10" }
        }
      ]
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/continue/i),
      expect.stringMatching(/chronological/i)
    ]));
  });

  it("keeps legacy briefs backward compatible without requiring legs", () => {
    const parsed = tripBriefSchema.parse({
      ...baseBrief,
      tripType: "one_way",
      destinationAirports: ["NYC"],
      stayNights: null,
      legs: undefined
    });
    expect(parsed.legs).toBeUndefined();
  });
});
