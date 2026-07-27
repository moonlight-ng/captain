import { describe, expect, it } from "vitest";

import {
  airportCodeAtStart,
  airportCodeForLocation,
  allowedModelAirportCodes,
  orderedAirportCodesFromText
} from "../services/trip-planning/airport-catalog.js";
import {
  sanitizeModelAirportExtraction,
  type TripFactExtraction
} from "../services/trip-planning/extractor.js";

function extraction(overrides: Partial<TripFactExtraction> = {}): TripFactExtraction {
  return {
    originAirports: [],
    destinationAirports: [],
    tripType: null,
    legs: [],
    travellers: null,
    cabin: null,
    maxStops: null,
    currency: null,
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    ...overrides
  };
}

describe("deterministic airport resolution", () => {
  it("maps Anambra and its airport aliases to ANA", () => {
    expect(airportCodeForLocation("Anambra")).toBe("ANA");
    expect(airportCodeForLocation("Umueri")).toBe("ANA");
    expect(airportCodeForLocation("Chinua Achebe")).toBe("ANA");
    expect(airportCodeAtStart("home to New York")).toBeNull();
    expect(airportCodeAtStart("New York next Sunday")).toBe("NYC");
    expect(orderedAirportCodesFromText("Lagos to Anambra this Saturday"))
      .toEqual(["LOS", "ANA"]);
  });

  it("allows a model code only when the user's words support it", () => {
    expect([...allowedModelAirportCodes("Lagos to Anambra this Saturday")])
      .toEqual(["LOS", "ANA"]);
    expect(sanitizeModelAirportExtraction(
      "Lagos to Anambra this Saturday",
      extraction({
        originAirports: ["LOS"],
        destinationAirports: ["ANS"],
        tripType: "one_way"
      })
    )).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: []
    });
  });

  it("preserves an explicit uppercase IATA code without letting ordinary words become codes", () => {
    expect([...allowedModelAirportCodes("Fly from LOS to DXB")])
      .toEqual(["LOS", "DXB"]);
    expect(airportCodeForLocation("ans")).toBeNull();
  });
});
