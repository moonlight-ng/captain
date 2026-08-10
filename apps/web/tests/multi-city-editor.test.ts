import { describe, expect, it } from "vitest";

import {
  addMultiCityLeg,
  removeMultiCityLeg,
  updateMultiCityLeg,
  type EditableTripBrief
} from "../src/multi-city-editor.js";

function brief(): EditableTripBrief {
  return {
    originAirports: ["LOS"],
    destinationAirports: ["LOS"],
    tripType: "multi_city",
    departureWindow: { start: "2026-11-01", end: "2026-11-01" },
    legs: [
      {
        originAirports: ["LOS"],
        destinationAirports: ["NBO"],
        departureWindow: { start: "2026-11-01", end: "2026-11-01" },
        arriveBy: "2026-11-04"
      },
      {
        originAirports: ["NBO"],
        destinationAirports: ["EBB"],
        departureWindow: { start: "2026-11-15", end: "2026-11-18" },
        arriveBy: "2026-11-19"
      },
      {
        originAirports: ["EBB"],
        destinationAirports: ["LOS"],
        departureWindow: { start: "2026-12-03", end: "2026-12-09" },
        arriveBy: "2026-12-10"
      }
    ],
    stayNights: null,
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 2,
    currency: "USD",
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    context: ""
  };
}

describe("multi-city Plan editor", () => {
  it("keeps adjacent route endpoints and the summary in sync", () => {
    const changed = updateMultiCityLeg(brief(), 1, {
      destinationAirports: ["KGL"],
      departureWindow: { start: "2026-11-16", end: "2026-11-18" }
    });

    expect(changed.legs?.[1]).toMatchObject({
      destinationAirports: ["KGL"],
      departureWindow: { start: "2026-11-16", end: "2026-11-18" }
    });
    expect(changed.legs?.[2]?.originAirports).toEqual(["KGL"]);
    expect(changed.originAirports).toEqual(["LOS"]);
    expect(changed.destinationAirports).toEqual(["LOS"]);
  });

  it("updates the summary window and last destination", () => {
    const first = updateMultiCityLeg(brief(), 0, {
      departureWindow: { start: "2026-10-31", end: "2026-11-02" }
    });
    const last = updateMultiCityLeg(first, 2, { destinationAirports: ["ACC"] });

    expect(last.departureWindow).toEqual({ start: "2026-10-31", end: "2026-11-02" });
    expect(last.destinationAirports).toEqual(["ACC"]);
  });

  it("adds and removes editable flight legs while reconnecting the route", () => {
    const added = addMultiCityLeg(brief());
    expect(added.legs).toHaveLength(4);
    expect(added.legs?.[3]).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: [],
      departureWindow: { start: "2026-12-09", end: "2026-12-09" }
    });

    const removed = removeMultiCityLeg(brief(), 1);
    expect(removed.legs).toHaveLength(2);
    expect(removed.legs?.[1]?.originAirports).toEqual(["NBO"]);
    expect(removed.destinationAirports).toEqual(["LOS"]);
  });
});
