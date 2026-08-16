import { describe, expect, it } from "vitest";

import {
  expandSearchDateCombinations,
  SearchWindowCombinationError,
  type SearchSpecRequest
} from "../src/index.js";

describe("expandSearchDateCombinations", () => {
  it("builds the complete Cartesian product in stable date order", () => {
    const expanded = expandSearchDateCombinations(request([
      { departureStart: "2026-08-10", departureEnd: "2026-08-11" },
      { departureStart: "2026-08-13", departureEnd: "2026-08-15" }
    ]));
    expect(expanded.map((item) => item.slices.map((slice) => slice.departureStart))).toEqual([
      ["2026-08-10", "2026-08-13"], ["2026-08-10", "2026-08-14"],
      ["2026-08-10", "2026-08-15"], ["2026-08-11", "2026-08-13"],
      ["2026-08-11", "2026-08-14"], ["2026-08-11", "2026-08-15"]
    ]);
    expect(expanded.every((item) => item.slices.every((slice) =>
      slice.departureStart === slice.departureEnd
    ))).toBe(true);
  });

  it("rejects invalid dates and combinations beyond the bounded search budget", () => {
    expect(() => expandSearchDateCombinations(request([
      { departureStart: "2026-02-30", departureEnd: "2026-03-01" }
    ]))).toThrow(SearchWindowCombinationError);
    expect(() => expandSearchDateCombinations(request([
      { departureStart: "2026-08-01", departureEnd: "2026-08-07" },
      { departureStart: "2026-08-08", departureEnd: "2026-08-14" },
      { departureStart: "2026-08-15", departureEnd: "2026-08-15" }
    ]), 48)).toThrow(/49 date combinations/u);
  });

  it("samples a fare digest across the full window without exhausting provider limits", () => {
    const digest = {
      ...request([{ departureStart: "2026-08-16", departureEnd: "2026-09-13" }]),
      fareContext: "fare_digest" as const
    };
    const expanded = expandSearchDateCombinations(digest);
    expect(expanded.map((item) => item.slices[0]?.departureStart)).toEqual([
      "2026-08-16",
      "2026-08-23",
      "2026-08-30",
      "2026-09-06",
      "2026-09-13"
    ]);
  });
});

function request(
  windows: Array<{ departureStart: string; departureEnd: string }>
): SearchSpecRequest {
  return {
    provider: "official_duffel",
    apiVersion: "v1",
    tripType: windows.length > 1 ? "multi_city" : "one_way",
    slices: windows.map((window, index) => ({
      originAirports: [index === 0 ? "LOS" : "LON"],
      destinationAirports: [index === windows.length - 1 ? "NYC" : "LON"],
      ...window
    })),
    stayNights: null,
    passenger: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxConnections: 1,
    currency: "USD",
    maximumPrice: null,
    fareContext: "public_beta"
  };
}
