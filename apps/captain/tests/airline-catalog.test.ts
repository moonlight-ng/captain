import { describe, expect, it } from "vitest";

import { airlineLabel, normalizeAirlineCode, searchAirlines } from "../src/airline-catalog.js";

describe("airline catalog search", () => {
  it("finds airlines by code or name and skips selected codes", () => {
    expect(searchAirlines("virg", ["BA"]).map((airline) => airline.code)).toContain("VS");
    expect(searchAirlines("BA", []).map((airline) => airline.code)).toEqual(["BA"]);
    expect(searchAirlines("", ["BA"]).some((airline) => airline.code === "BA")).toBe(false);
  });

  it("labels known codes and normalizes free-typed codes", () => {
    expect(airlineLabel("KQ")).toBe("Kenya Airways");
    expect(airlineLabel("zz")).toBe("ZZ");
    expect(normalizeAirlineCode(" ba ")).toBe("BA");
    expect(normalizeAirlineCode("1")).toBeNull();
  });
});
