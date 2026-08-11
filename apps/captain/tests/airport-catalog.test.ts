import { describe, expect, it } from "vitest";
import { METROPOLITAN_AIRPORT_GROUPS } from "@agents/flight-domain";

import {
  airportCodeAtStart,
  airportCodeForLocation,
  allowedModelAirportCodes,
  countryAirportGuess,
  knownAirportCodes,
  orderedAirportCodesFromText,
  orderedAirportMentionsFromText
} from "../services/trip-planning/airport-catalog.js";
import { TripPlanningService } from "../services/trip-planning/service.js";
import { isNarrativeItineraryRequest } from "../services/trip-planning/itinerary-constraints.js";
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

/**
 * Presence dates are bound to cities by source offset before any leg exists,
 * so a mention that cannot be sliced back out of the original text silently
 * attaches the wrong dates to the wrong stop.
 */
describe("mention source offsets", () => {
  const sentences = [
    "Paris in November for a wedding, then New York on December 10.",
    "  Lagos   to    Abuja  next Saturday",
    "I’ll be in São Paulo, then Zürich, then back to London.",
    "from LAGOS to accra to Nairobi",
    "Tokyo — then Singapore (two nights) — then Cape Town."
  ];

  it("returns evidence that slices back out of the original text", () => {
    for (const sentence of sentences) {
      for (const mention of orderedAirportMentionsFromText(sentence)) {
        expect(sentence.slice(mention.index, mention.index + mention.evidence.length))
          .toBe(mention.evidence);
      }
    }
  });

  it("returns mentions in ascending source order", () => {
    for (const sentence of sentences) {
      const indexes = orderedAirportMentionsFromText(sentence).map((m) => m.index);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    }
  });

  it("keeps evidence non-empty and inside the text", () => {
    for (const sentence of sentences) {
      for (const mention of orderedAirportMentionsFromText(sentence)) {
        expect(mention.evidence.length).toBeGreaterThan(0);
        expect(mention.index).toBeGreaterThanOrEqual(0);
        expect(mention.index + mention.evidence.length).toBeLessThanOrEqual(sentence.length);
      }
    }
  });
});

/**
 * Ordinary conversation must not resolve to airports. A false positive here
 * does not shorten an itinerary — it hijacks a whole turn into trip planning,
 * because the same mention counter gates all three routing predicates.
 */
describe("ordinary conversation is not a route", () => {
  const conversation = [
    "Works",
    "Yes, that's right",
    "Nice, thanks",
    "That's a nice option",
    "Let's split the difference",
    "Same as before",
    "Of course",
    "Best I can do",
    "Reading through it now",
    "Can you split that into two messages?",
    "What's the price range looking like?",
    "That's a lot of stops",
    "Cancel it please",
    "How does the tracking work?",
    "Sounds good to me",
    "No return needed",
    "I'd rather fly in the morning",
    "Economy is fine",
    "Just me",
    "Make it business class",
    "Can I change the currency?",
    "Why is it so expensive?",
    "Let me think about it",
    "Send me the link again",
    "What airlines did you check?",
    "Is there anything cheaper?",
    "Thanks, that's helpful",
    "Not this time",
    "Hold on",
    "Try again"
  ];

  it("finds no airports in it", () => {
    for (const message of conversation) {
      expect({ message, codes: orderedAirportCodesFromText(message) })
        .toEqual({ message, codes: [] });
    }
  });

  it("does not route it into trip planning", () => {
    for (const message of conversation) {
      expect({ message, planning: TripPlanningService.isTripPlanningRequest(message) })
        .toEqual({ message, planning: false });
      expect({ message, itinerary: TripPlanningService.needsItineraryPlanningConversation(message) })
        .toEqual({ message, itinerary: false });
      expect({ message, narrative: isNarrativeItineraryRequest(message) })
        .toEqual({ message, narrative: false });
    }
  });
});

/**
 * A city-level code is not bookable. `airportCodeMatches` accepts a provider
 * offer only when the requested code is the airport itself or a metropolitan
 * code with a group, so any metro code the catalog learns without a matching
 * group entry makes every offer for that city fail and reads as "no fares".
 */
describe("metropolitan overlay", () => {
  it("keeps every metropolitan group resolvable by the catalog", () => {
    const codes = knownAirportCodes();
    for (const code of Object.keys(METROPOLITAN_AIRPORT_GROUPS)) {
      expect({ code, known: codes.has(code) }).toEqual({ code, known: true });
    }
  });

  it("emits no city-level code the providers cannot match", () => {
    // Adding a metro code to the catalog means adding its group too. This list
    // is the tripwire: change it only alongside METROPOLITAN_AIRPORT_GROUPS.
    const metropolitan = [...knownAirportCodes()]
      .filter((code) => code in METROPOLITAN_AIRPORT_GROUPS)
      .sort();
    expect(metropolitan).toEqual(["LON", "NYC", "PAR", "TYO"]);
  });
});
