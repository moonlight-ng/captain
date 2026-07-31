import { describe, expect, it } from "vitest";

import {
  addIsoDays,
  daysBetween,
  formatCalendarDate,
  parseIsoDate,
  tripDraftStateSchema,
  weekdayName
} from "../src/trip-planning.js";

describe("trip planning calendar", () => {
  it("derives a seven-night Sunday-to-Sunday stay", () => {
    expect(weekdayName("2025-08-17")).toBe("Sunday");
    expect(addIsoDays("2025-08-17", 7)).toBe("2025-08-24");
    expect(daysBetween("2025-08-17", "2025-08-24")).toBe(7);
  });

  it("handles month and leap-year boundaries", () => {
    expect(addIsoDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addIsoDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("rejects invalid calendar dates and formats weekdays from the date", () => {
    expect(() => parseIsoDate("2026-02-29")).toThrow("Invalid date");
    expect(formatCalendarDate("2026-08-17")).toContain("Monday");
  });

  it("validates the version-3 canonical state", () => {
    expect(tripDraftStateSchema.parse({
      version: 3,
      tripType: "round_trip",
      legs: [{
        originAirports: ["LOS"],
        destinationAirports: ["NYC"],
        departure: { kind: "exact", date: "2026-08-09" }
      }, {
        originAirports: ["NYC"],
        destinationAirports: ["LOS"],
        departure: { kind: "exact", date: "2026-08-16" }
      }],
      travellers: null,
      cabin: "economy",
      maxStops: 1,
      currency: "NGN",
      maximumPrice: null,
      preferredAirlines: [],
      excludedAirlines: []
    }).version).toBe(3);
  });
});
