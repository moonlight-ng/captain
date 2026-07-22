import { describe, expect, it } from "vitest";

import {
  currentProcessingTimeMs,
  formatProcessingTime,
  type FlightAgent
} from "../src/domain.js";

describe("processing time presentation", () => {
  it("formats minute, hour, and day boundaries", () => {
    expect(formatProcessingTime(0)).toBe("0s");
    expect(formatProcessingTime(999)).toBe("0s");
    expect(formatProcessingTime(45_000)).toBe("45s");
    expect(formatProcessingTime(59_999)).toBe("59s");
    expect(formatProcessingTime(60_000)).toBe("1m");
    expect(formatProcessingTime(3_660_000)).toBe("1h 1m");
    expect(formatProcessingTime(90_000_000)).toBe("1d 1h");
    expect(formatProcessingTime(Number.NaN)).toBe("0s");
  });

  it("adds live time only when processing has started", () => {
    const base = {
      accumulatedProcessingMs: 120_000,
      processingStartedAt: null
    } as FlightAgent;
    const now = Date.parse("2026-08-01T00:01:00Z");
    expect(currentProcessingTimeMs(base, now)).toBe(120_000);
    expect(currentProcessingTimeMs({
      ...base,
      processingStartedAt: "2026-08-01T00:00:30Z"
    }, now)).toBe(150_000);
  });

});
