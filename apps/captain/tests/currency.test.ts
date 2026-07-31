import { describe, expect, it } from "vitest";

import {
  isDomesticRoute,
  suggestedMaxStops,
  suggestedTripCurrency
} from "../services/trip-planning/currency.js";

describe("Trip currency suggestions", () => {
  it("keeps USD/GBP profile defaults and falls back to USD otherwise", () => {
    expect(suggestedTripCurrency({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["ABV"], departure: null }]
    }, "USD")).toBe("USD");
    expect(suggestedTripCurrency({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["LHR"], departure: null }]
    }, "GBP")).toBe("GBP");
    expect(suggestedTripCurrency({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["JFK"], departure: null }]
    }, "NGN")).toBe("USD");
    expect(suggestedTripCurrency({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["LHR"], departure: null }]
    }, "NGN")).toBe("GBP");
  });
});

describe("Route support", () => {
  it("detects same-country routes for default stop suggestions", () => {
    expect(isDomesticRoute({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["ABV"], departure: null }]
    })).toBe(true);
    expect(isDomesticRoute({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["LHR"], departure: null }]
    })).toBe(false);
  });

  it("defaults domestic routes to one stop and cross-border routes to two", () => {
    expect(suggestedMaxStops({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["ABV"], departure: null }]
    })).toBe(1);
    expect(suggestedMaxStops({
      tripType: "one_way",
      legs: [{ originAirports: ["LOS"], destinationAirports: ["LHR"], departure: null }]
    })).toBe(2);
  });
});
