import { describe, expect, it } from "vitest";

import { suggestedTripCurrency } from "../services/trip-planning/currency.js";

describe("Trip currency suggestions", () => {
  it("uses the route-country currency only when every airport is domestic", () => {
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["ABV"],
      tripType: "one_way",
      legs: []
    }, "USD")).toBe("NGN");
  });

  it("uses the profile default for international, multi-country, and unknown routes", () => {
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["LHR"],
      tripType: "one_way",
      legs: []
    }, "EUR")).toBe("EUR");
    expect(suggestedTripCurrency({
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      tripType: "multi_city",
      legs: [
        { originAirports: ["LOS"], destinationAirports: ["ABV"], departureDate: null },
        { originAirports: ["ABV"], destinationAirports: ["LHR"], departureDate: null }
      ]
    }, "GBP")).toBe("GBP");
    expect(suggestedTripCurrency({
      originAirports: ["XYZ"],
      destinationAirports: ["ABC"],
      tripType: "one_way",
      legs: []
    }, "USD")).toBe("USD");
  });
});
