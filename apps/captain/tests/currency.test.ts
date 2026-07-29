import { describe, expect, it } from "vitest";

import {
  isDomesticRoute,
  suggestedMaxStops,
  suggestedTripCurrency
} from "../services/trip-planning/currency.js";

describe("Trip currency suggestions", () => {
  it("keeps USD/GBP profile defaults and falls back to USD otherwise", () => {
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["ABV"],
      tripType: "one_way",
      legs: []
    }, "USD")).toBe("USD");
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["LHR"],
      tripType: "one_way",
      legs: []
    }, "GBP")).toBe("GBP");
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["JFK"],
      tripType: "one_way",
      legs: []
    }, "NGN")).toBe("USD");
  });
});

describe("Route support", () => {
  it("detects same-country routes for default stop suggestions", () => {
    expect(isDomesticRoute({
      originAirports: ["LOS"],
      destinationAirports: ["ABV"],
      tripType: "one_way",
      legs: []
    })).toBe(true);
    expect(isDomesticRoute({
      originAirports: ["LOS"],
      destinationAirports: ["LHR"],
      tripType: "one_way",
      legs: []
    })).toBe(false);
  });

  it("defaults domestic routes to one stop and cross-border routes to two", () => {
    expect(suggestedMaxStops({
      originAirports: ["LOS"],
      destinationAirports: ["ABV"],
      tripType: "one_way",
      legs: []
    })).toBe(1);
    expect(suggestedMaxStops({
      originAirports: ["LOS"],
      destinationAirports: ["LHR"],
      tripType: "one_way",
      legs: []
    })).toBe(2);
  });
});
