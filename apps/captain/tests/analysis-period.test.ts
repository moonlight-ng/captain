import { describe, expect, it } from "vitest";

import {
  resolveAnalysisPeriod,
  resolvePreviousAnalysisPeriod
} from "../services/trips/analysis-period.js";

const NOW = new Date("2026-08-08T18:30:00.000Z");

describe("analysis period resolution", () => {
  it("resolves rolling and calendar periods in UTC", () => {
    expect(resolveAnalysisPeriod({ preset: "last_7_days" }, NOW)).toEqual({
      startDay: "2026-08-02",
      endDay: "2026-08-08"
    });
    expect(resolveAnalysisPeriod({ preset: "this_week" }, NOW)).toEqual({
      startDay: "2026-08-03",
      endDay: "2026-08-08"
    });
    expect(resolveAnalysisPeriod({ preset: "last_month" }, NOW)).toEqual({
      startDay: "2026-07-01",
      endDay: "2026-07-31"
    });
    expect(resolveAnalysisPeriod({ preset: "all_history" }, NOW)).toEqual({
      startDay: null,
      endDay: null
    });
  });

  it("uses the natural prior calendar period for comparisons", () => {
    const thisWeek = resolveAnalysisPeriod({ preset: "this_week" }, NOW);
    expect(resolvePreviousAnalysisPeriod({ preset: "this_week" }, thisWeek, NOW)).toEqual({
      startDay: "2026-07-27",
      endDay: "2026-08-02"
    });

    const lastMonth = resolveAnalysisPeriod({ preset: "last_month" }, NOW);
    expect(resolvePreviousAnalysisPeriod({ preset: "last_month" }, lastMonth, NOW)).toEqual({
      startDay: "2026-06-01",
      endDay: "2026-06-30"
    });
  });

  it("compares a custom range with the immediately preceding equal-size range", () => {
    const spec = { startDate: "2026-08-01", endDate: "2026-08-05" } as const;
    const resolved = resolveAnalysisPeriod(spec, NOW);
    expect(resolvePreviousAnalysisPeriod(spec, resolved, NOW)).toEqual({
      startDay: "2026-07-27",
      endDay: "2026-07-31"
    });
  });

  it("rejects a reversed custom range and cannot precede all retained history", () => {
    expect(() => resolveAnalysisPeriod({
      startDate: "2026-08-08",
      endDate: "2026-08-01"
    }, NOW)).toThrow("start date");
    expect(resolvePreviousAnalysisPeriod(
      { preset: "all_history" },
      { startDay: null, endDay: null },
      NOW
    )).toBeNull();
  });
});
