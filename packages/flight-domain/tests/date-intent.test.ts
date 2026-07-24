import { describe, expect, it } from "vitest";

import { resolveTripDateIntent } from "../src/date-intent.js";

const now = new Date("2025-07-01T12:00:00Z");

describe("trip date intent", () => {
  it("resolves Sunday and the following Sunday as seven nights", () => {
    expect(resolveTripDateIntent(
      "Round trip for the week starting Sunday, August 17 and back Sunday the following week",
      now
    )).toEqual({
      departureDate: "2025-08-17",
      returnDate: "2025-08-24",
      issue: null
    });
  });

  it("clarifies a weekday conflict instead of changing the date", () => {
    const result = resolveTripDateIntent(
      "Depart Sunday August 17 2026 and return Sunday August 24 2026",
      now
    );
    expect(result.issue).toContain("Monday, not Sunday");
  });

  it("supports return-only corrections and rejects reversed dates", () => {
    expect(resolveTripDateIntent("Change the return to August 24, 2025", now)).toEqual({
      departureDate: null,
      returnDate: "2025-08-24",
      issue: null
    });
    expect(resolveTripDateIntent(
      "Depart August 24, 2025 and return August 17, 2025",
      now
    ).issue).toContain("after the departure");
  });

  it("resolves compact date ranges for open-jaw and multi-city requests", () => {
    expect(resolveTripDateIntent("Fly from Lagos to New York to London from Aug 16 - 23", now)).toEqual({
      departureDate: "2025-08-16",
      returnDate: "2025-08-23",
      issue: null
    });
    expect(resolveTripDateIntent("Fly 16–23 Aug", now)).toEqual({
      departureDate: "2025-08-16",
      returnDate: "2025-08-23",
      issue: null
    });
  });

  it("rejects invalid leap dates and past departures", () => {
    expect(resolveTripDateIntent("Depart February 29, 2026", now).issue).toContain("not a valid");
    expect(resolveTripDateIntent(
      "Depart June 1, 2025",
      new Date("2025-07-01T00:00:00Z")
    ).issue).toContain("in the past");
  });
});
