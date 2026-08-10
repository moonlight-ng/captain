import { describe, expect, it } from "vitest";

import {
  airportCodeAtStart,
  airportCodeForLocation,
  allowedModelAirportCodes,
  countryAirportGuess,
  orderedAirportCodesFromText,
  orderedAirportMentionsFromText
} from "../services/trip-planning/airport-catalog.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
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

describe("country resolution", () => {
  // A country used to contribute no mention at all, so a traveller naming
  // Paris, Japan and New York looked like they named two places — one short
  // of the threshold that routes an itinerary into planning, and the Japan
  // leg was dropped without a word.
  it("counts a country as a location so a three-stop itinerary reads as three", () => {
    const itinerary = "Paris in November for a wedding. Then I'll be in Japan. "
      + "Then a wedding in New York on December 10.";
    const mentions = orderedAirportMentionsFromText(itinerary);
    expect(mentions.map((mention) => mention.code)).toEqual(["PAR", "TYO", "NYC"]);
    expect(mentions.map((mention) => mention.assumed)).toEqual([false, true, false]);
  });

  it("marks only the country-derived airport as assumed", () => {
    expect(airportCodeForLocation("Japan")).toBe("TYO");
    expect(airportCodeForLocation("Tokyo")).toBe("TYO");
    const [country] = orderedAirportMentionsFromText("flying to Japan");
    const [city] = orderedAirportMentionsFromText("flying to Tokyo");
    expect(country).toMatchObject({ code: "TYO", assumed: true, evidence: "Japan" });
    expect(city).toMatchObject({ code: "TYO", assumed: false, evidence: "Tokyo" });
  });

  it("offers only cities the catalog can actually search", () => {
    // Every Japanese airport in the catalog is Tokyo, so there is no honest
    // alternative to offer — better silence than suggesting an Osaka Captain
    // cannot search.
    expect(countryAirportGuess("japan")).toEqual({
      code: "TYO",
      countryLabel: "Japan",
      alternatives: []
    });
    expect(countryAirportGuess("south africa")).toEqual({
      code: "JNB",
      countryLabel: "South Africa",
      alternatives: ["Cape Town", "Durban"]
    });
    expect(countryAirportGuess("narnia")).toBeNull();
  });

  it("leaves a city-state as a certainty rather than a guess", () => {
    const [singapore] = orderedAirportMentionsFromText("stopping in Singapore");
    expect(singapore).toMatchObject({ code: "SIN", assumed: false });
  });

  it("does not turn two countries in passing into a planning request", () => {
    // The mention counter is shared with the routing predicates, so widening
    // it must not make reminiscing look like an itinerary.
    expect(TripPlanningService.needsItineraryPlanningConversation(
      "I loved my time in France and Japan"
    )).toBe(false);
  });
});
