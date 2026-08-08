import { describe, expect, it } from "vitest";

import { analyzePriceHistory } from "../src/price-analysis.js";

const observations = [
  point("2026-07-27", 500),
  point("2026-07-28", 520),
  point("2026-07-29", 540),
  point("2026-08-03", 450),
  point("2026-08-04", 420),
  point("2026-08-05", 400)
];

describe("price history analysis", () => {
  it("summarizes change inside a requested period", () => {
    const result = analyzePriceHistory({
      observations,
      currency: "GBP",
      period: { startDay: "2026-08-03", endDay: "2026-08-09" }
    });

    expect(result.period).toMatchObject({
      observedDays: 3,
      openingPrice: 450,
      closingPrice: 400,
      lowPrice: 400,
      highPrice: 450,
      averagePrice: 423.33,
      change: -50,
      changePercent: -11.1,
      direction: "down"
    });
    expect(result.comparison).toBeNull();
    expect(result.insight).toContain("fell by £50 (11.1%)");
  });

  it("compares period averages without asking the model to calculate them", () => {
    const result = analyzePriceHistory({
      observations,
      currency: "GBP",
      period: { startDay: "2026-08-03", endDay: "2026-08-09" },
      comparisonPeriod: { startDay: "2026-07-27", endDay: "2026-08-02" }
    });

    expect(result.comparisonPeriod?.averagePrice).toBe(520);
    expect(result.comparison).toEqual({
      averagePriceDifference: -96.67,
      averagePriceDifferencePercent: -18.6,
      closingPriceDifference: -140,
      closingPriceDifferencePercent: -25.9,
      direction: "lower"
    });
    expect(result.insight).toContain("£96.67 (18.6%) lower");
    expect(result.insight).toContain("3 days with data");
  });

  it("makes missing and one-point periods explicit", () => {
    const missing = analyzePriceHistory({
      observations,
      currency: "GBP",
      period: { startDay: "2026-09-01", endDay: "2026-09-07" }
    });
    const single = analyzePriceHistory({
      observations,
      currency: "GBP",
      period: { startDay: "2026-08-05", endDay: "2026-08-05" }
    });

    expect(missing.period).toBeNull();
    expect(missing.insight).toContain("No daily price data");
    expect(single.insight).toContain("within-period change cannot be established");
  });

  it("still reports the requested period when comparison data is absent", () => {
    const result = analyzePriceHistory({
      observations,
      currency: "GBP",
      period: { startDay: "2026-08-03", endDay: "2026-08-09" },
      comparisonPeriod: { startDay: "2026-06-01", endDay: "2026-06-07" }
    });

    expect(result.period?.observedDays).toBe(3);
    expect(result.comparisonPeriod).toBeNull();
    expect(result.comparison).toBeNull();
  });
});

function point(day: string, price: number) {
  return { price, observedAt: `${day}T06:00:00.000Z` };
}
