import { describe, expect, it } from "vitest";

import {
  compileItineraryConstraints,
  deterministicItineraryConstraints,
  isNarrativeItineraryRequest,
  type ItineraryConstraintSet
} from "../services/trip-planning/itinerary-constraints.js";

const request = "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
  + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
  + "I'll be in London and want to spend Christmas in Lagos.";
const now = new Date("2026-08-08T12:00:00Z");

describe("narrative itinerary constraints", () => {
  it("extracts city presence without treating event endpoints as flights", () => {
    expect(isNarrativeItineraryRequest(request)).toBe(true);
    const constraints = deterministicItineraryConstraints({
      request,
      now,
      timeZone: "Africa/Lagos"
    });

    expect(constraints).toMatchObject({
      origin: null,
      stops: [
        { airportCode: "NBO" },
        { airportCode: "EBB" },
        { airportCode: "LON" },
        { airportCode: "LOS" }
      ],
      presence: [
        { airportCode: "NBO", startExpression: "2026-11-04", endExpression: "2026-11-08" },
        { airportCode: "NBO", startExpression: "2026-11-10", endExpression: "2026-11-14" },
        { airportCode: "EBB", startExpression: "2026-11-19", endExpression: "2026-11-22" },
        { airportCode: "LON", startExpression: "2026-12-10", endExpression: "2026-12-10" },
        { airportCode: "LOS", startExpression: "2026-12-25", endExpression: "2026-12-25" }
      ]
    });
  });

  it("keeps an unstated origin open and separates feasible gaps from search windows", () => {
    const constraints = deterministicItineraryConstraints({
      request,
      now,
      timeZone: "Africa/Lagos"
    });
    expect(constraints).not.toBeNull();
    const compiled = compileItineraryConstraints(
      constraints!,
      now,
      "Africa/Lagos"
    );

    expect(compiled.prompt).toContain("Where will you be flying from to Nairobi?");
    expect(compiled.state.legs).toEqual([
      {
        originAirports: [],
        destinationAirports: ["NBO"],
        departure: null,
        arriveBy: "2026-11-04",
        feasibleDepartureWindow: null,
        proposedDeparture: null
      },
      {
        originAirports: ["NBO"],
        destinationAirports: ["EBB"],
        departure: {
          kind: "window",
          start: "2026-11-15",
          end: "2026-11-18",
          source: "Derived from the traveller’s city availability"
        },
        arriveBy: "2026-11-19",
        feasibleDepartureWindow: { start: "2026-11-15", end: "2026-11-18" },
        proposedDeparture: null
      },
      {
        originAirports: ["EBB"],
        destinationAirports: ["LON"],
        departure: null,
        arriveBy: "2026-12-10",
        feasibleDepartureWindow: { start: "2026-11-23", end: "2026-12-09" },
        proposedDeparture: {
          kind: "window",
          start: "2026-12-03",
          end: "2026-12-09",
          source: "Captain’s proposed seven-day search window"
        }
      },
      {
        originAirports: ["LON"],
        destinationAirports: ["LOS"],
        departure: null,
        arriveBy: "2026-12-25",
        feasibleDepartureWindow: { start: "2026-12-11", end: "2026-12-24" },
        proposedDeparture: {
          kind: "window",
          start: "2026-12-18",
          end: "2026-12-24",
          source: "Captain’s proposed seven-day search window"
        }
      }
    ]);
    expect(compiled.state.legs).toHaveLength(4);
  });

  it("asks for the missing city boundary instead of inventing a flight date", () => {
    const constraints: ItineraryConstraintSet = {
      origin: { airportCode: "NBO", evidence: "Nairobi" },
      stops: [
        { airportCode: "EBB", evidence: "Uganda" },
        { airportCode: "LON", evidence: "London" }
      ],
      presence: [
        {
          airportCode: "NBO",
          startExpression: "2026-11-04",
          endExpression: "2026-11-14",
          evidence: "November 4 to 14"
        },
        {
          airportCode: "EBB",
          startExpression: "2026-11-19",
          endExpression: "2026-11-22",
          evidence: "November 19 to 22"
        }
      ],
      question: null
    };

    const compiled = compileItineraryConstraints(constraints, now, "Africa/Lagos");
    expect(compiled.state.legs).toHaveLength(2);
    expect(compiled.prompt).toBe("By what date do you need to reach London?");
    expect(compiled.state.legs[1]).toMatchObject({
      originAirports: ["EBB"],
      destinationAirports: ["LON"],
      departure: null
    });
  });

  it("treats a city as the origin only when the traveller says it explicitly", () => {
    const explicit = deterministicItineraryConstraints({
      request: "I'm starting in Accra. I need to be in Nairobi Nov 4 - 14, Uganda Nov 19 - 22, and London Dec 10.",
      now,
      timeZone: "Africa/Lagos"
    });

    expect(explicit).toMatchObject({
      origin: { airportCode: "ACC", evidence: "Accra" },
      stops: [
        { airportCode: "NBO" },
        { airportCode: "EBB" },
        { airportCode: "LON" }
      ]
    });
  });
});
