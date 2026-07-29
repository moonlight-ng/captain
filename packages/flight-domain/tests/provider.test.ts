import { describe, expect, it } from "vitest";

import {
  duffelInventoryEligible,
  isSupportedTripCurrency,
  primaryFlightInventoryProvider
} from "../src/provider.js";

describe("Captain inventory provider", () => {
  it("uses Duffel for the supported Trip currencies", () => {
    expect(primaryFlightInventoryProvider()).toBe("official_duffel");
    expect(primaryFlightInventoryProvider({
      tripCurrency: "USD",
      domesticRoute: false
    })).toBe("official_duffel");
    expect(isSupportedTripCurrency("gbp")).toBe(true);
    expect(isSupportedTripCurrency("NGN")).toBe(false);
    expect(duffelInventoryEligible({ tripCurrency: "USD" })).toBe(true);
    expect(duffelInventoryEligible({ tripCurrency: "NGN" })).toBe(false);
  });
});
