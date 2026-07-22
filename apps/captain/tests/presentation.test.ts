import { describe, expect, it } from "vitest";

import { formatCompactDateRange } from "../src/domain.js";

describe("presentation formatting", () => {
  it("formats compact workspace date ranges", () => {
    expect(formatCompactDateRange("2026-09-15", "2026-09-16")).toBe("Sep 15 – 16");
    expect(formatCompactDateRange("2026-09-15", "2026-09-15")).toBe("Sep 15");
    expect(formatCompactDateRange("2026-09-30", "2026-10-02")).toBe("Sep 30 – Oct 2");
    expect(formatCompactDateRange("2026-12-31", "2027-01-02")).toBe("Dec 31, 2026 – Jan 2, 2027");
  });
});
