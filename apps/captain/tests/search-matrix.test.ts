import { describe, expect, it } from "vitest";

import { buildSearchMatrix } from "../services/domain/search-matrix.js";
import { defaultTestBrief } from "./support.js";

describe("buildSearchMatrix", () => {
  it("caps each run at 24 and advances a deterministic cursor", () => {
    const brief = defaultTestBrief({
      originAirports: ["LHR", "LGW"],
      destinationAirports: ["JFK", "EWR"],
      departureWindow: { start: "2026-09-01", end: "2026-09-10" }
    });
    const first = buildSearchMatrix(brief, 0);
    const second = buildSearchMatrix(brief, first.nextCursor);
    expect(first.total).toBe(120);
    expect(first.matrix).toHaveLength(24);
    expect(second.matrix).toHaveLength(24);
    expect(second.matrix[0]).toEqual(first.matrix.at(-1)
      ? expect.not.objectContaining(first.matrix.at(-1)!)
      : expect.anything());
    expect(second.nextCursor).toBe(48);
  });

  it("covers every combination without duplication when the space is small", () => {
    const result = buildSearchMatrix(defaultTestBrief({
      departureWindow: { start: "2026-09-01", end: "2026-09-02" },
      stayNights: { minimum: 7, preferred: 7, maximum: 7 }
    }), 0);
    expect(result.total).toBe(2);
    expect(new Set(result.matrix.map((item) => JSON.stringify(item))).size).toBe(2);
  });

  it("searches the middle of a flexible window and the preferred stay first", () => {
    const result = buildSearchMatrix(defaultTestBrief({
      departureWindow: { start: "2026-08-24", end: "2026-08-30" },
      stayNights: { minimum: 4, preferred: 5, maximum: 7 }
    }), 0, 1);

    expect(result.matrix).toEqual([{
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-08-27",
      returnDate: "2026-09-01"
    }]);
  });
});
