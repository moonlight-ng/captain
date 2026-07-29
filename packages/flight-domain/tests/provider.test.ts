import { describe, expect, it } from "vitest";

import { primaryFlightInventoryProvider } from "../src/provider.js";

describe("Captain inventory provider", () => {
  it("uses verified web research for every Trip currency and route", () => {
    expect(primaryFlightInventoryProvider()).toBe("openai_web");
    expect(primaryFlightInventoryProvider({
      tripCurrency: "NGN",
      domesticRoute: true
    })).toBe("openai_web");
  });
});
