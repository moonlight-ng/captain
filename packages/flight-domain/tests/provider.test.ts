import { describe, expect, it } from "vitest";

import {
  duffelInventoryEligible,
  isSupportedTripCurrency,
  primaryFlightInventoryProvider
} from "../src/provider.js";

describe("Duffel inventory eligibility", () => {
  it("allows USD/GBP Trips including domestic routes", () => {
    expect(duffelInventoryEligible({
      tripCurrency: "USD",
      domesticRoute: false
    })).toBe(true);
    expect(duffelInventoryEligible({
      tripCurrency: "GBP",
      domesticRoute: false
    })).toBe(true);
    expect(duffelInventoryEligible({
      tripCurrency: "NGN",
      domesticRoute: false
    })).toBe(false);
    expect(duffelInventoryEligible({
      tripCurrency: "USD",
      domesticRoute: true
    })).toBe(true);
    expect(isSupportedTripCurrency("EUR")).toBe(false);
    expect(primaryFlightInventoryProvider()).toBe("official_duffel");
  });
});
