import { describe, expect, it } from "vitest";

import {
  resolveTripDateIntent,
  resolveTripDateSequence
} from "../src/date-intent.js";

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

  it("inherits a month and year for a later ordinal day", () => {
    expect(resolveTripDateIntent(
      "To New York on Aug 17. Return to London on the 23rd",
      new Date("2026-07-27T00:00:00Z")
    )).toEqual({
      departureDate: "2026-08-17",
      returnDate: "2026-08-23",
      issue: null
    });
  });

  it("returns every dated leg for longer multi-city itineraries", () => {
    expect(resolveTripDateSequence(
      "Lagos on Aug 17, New York on the 20th, London on the 23rd",
      new Date("2026-07-27T00:00:00Z")
    )).toEqual({
      dates: ["2026-08-17", "2026-08-20", "2026-08-23"],
      issue: null
    });
  });

  it("resolves relative dates in the traveller's timezone", () => {
    expect(resolveTripDateIntent(
      "Fly today",
      new Date("2026-07-31T23:30:00Z"),
      "Africa/Lagos"
    )).toEqual({
      departureDate: "2026-08-01",
      returnDate: null,
      issue: null
    });
  });

  it("resolves common relative dates deterministically", () => {
    expect(resolveTripDateIntent("Fly this Saturday", now)).toEqual({
      departureDate: "2025-07-05",
      returnDate: null,
      issue: null
    });
    expect(resolveTripDateIntent("Fly tomorrow", now)).toEqual({
      departureDate: "2025-07-02",
      returnDate: null,
      issue: null
    });
    expect(resolveTripDateIntent("Fly in two weeks", now)).toEqual({
      departureDate: "2025-07-15",
      returnDate: null,
      issue: null
    });
    expect(resolveTripDateIntent("Fly Saturday", new Date("2025-07-05T12:00:00Z"))).toEqual({
      departureDate: "2025-07-05",
      returnDate: null,
      issue: null
    });
  });

  it("anchors a next-day return to the departure in the same request", () => {
    expect(resolveTripDateIntent(
      "Fly this Sunday and return to Lagos the next day",
      new Date("2026-07-27T07:55:00Z")
    )).toEqual({
      departureDate: "2026-08-02",
      returnDate: "2026-08-03",
      issue: null
    });
  });

  it("resolves ordinal weekdays within a named month", () => {
    expect(resolveTripDateIntent(
      "First Sunday September, not August",
      new Date("2026-07-29T00:00:00Z")
    )).toEqual({
      departureDate: "2026-09-06",
      returnDate: null,
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
