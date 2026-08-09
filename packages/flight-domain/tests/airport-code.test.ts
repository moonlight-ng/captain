import { describe, expect, it } from "vitest";

import { airportCodeMatches } from "../src/airport-code.js";

describe("airportCodeMatches", () => {
  it("matches metropolitan search codes to their real airports", () => {
    expect(airportCodeMatches(["NYC"], "JFK")).toBe(true);
    expect(airportCodeMatches(["NYC"], "EWR")).toBe(true);
    expect(airportCodeMatches(["LON"], "LHR")).toBe(true);
    expect(airportCodeMatches(["TYO"], "HND")).toBe(true);
    expect(airportCodeMatches(["PAR"], "ORY")).toBe(true);
  });

  it("does not conflate unrelated airports", () => {
    expect(airportCodeMatches(["NYC"], "BOS")).toBe(false);
    expect(airportCodeMatches(["NRT"], "HND")).toBe(false);
  });
});
