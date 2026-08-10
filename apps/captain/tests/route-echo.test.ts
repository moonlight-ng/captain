import { describe, expect, it } from "vitest";

import {
  captainOpeningStatus,
  CAPTAIN_OPENING_STATUS_VARIANTS
} from "../agent/channels/telegram.js";
import { tripRouteEcho } from "../services/trip-planning/route-echo.js";

describe("trip route echo", () => {
  it("reads a bare route the traveller opened with", () => {
    expect(tripRouteEcho("Lagos to London")).toBe("Lagos to London");
    expect(tripRouteEcho("LOS to LHR in September")).toBe("LOS to LHR");
    expect(tripRouteEcho("New York to San Francisco in May")).toBe(
      "New York to San Francisco"
    );
  });

  it("reads a route stated with from", () => {
    expect(tripRouteEcho("I want to track a flight from Lagos to London in September"))
      .toBe("Lagos to London");
    expect(tripRouteEcho("can you find me something from Accra to Dubai next month"))
      .toBe("Accra to Dubai");
  });

  it("stops the place name at the dates rather than swallowing them", () => {
    expect(tripRouteEcho("Lagos to London September 6")).toBe("Lagos to London");
    expect(tripRouteEcho("Lagos to London 2026-09-06")).toBe("Lagos to London");
    expect(tripRouteEcho("Lagos to London next weekend")).toBe("Lagos to London");
    expect(tripRouteEcho("Lagos to London, early December")).toBe("Lagos to London");
  });

  it("tidies their casing without inventing a different spelling", () => {
    expect(tripRouteEcho("lagos to london")).toBe("Lagos to London");
    // An airport code is not a word to title-case.
    expect(tripRouteEcho("LOS to LHR")).toBe("LOS to LHR");
    expect(tripRouteEcho("Port Harcourt to Abu Dhabi")).toBe("Port Harcourt to Abu Dhabi");
  });

  it("refuses to echo a sentence fragment as a place", () => {
    // The failure that matters: "I want to fly to Lagos" must never come back
    // as "I want to fly", which would read as Captain misunderstanding them.
    expect(tripRouteEcho("I want to fly to Lagos")).toBeNull();
    expect(tripRouteEcho("I need to get to Paris in June")).toBeNull();
    expect(tripRouteEcho("flights to Paris next month")).toBeNull();
    expect(tripRouteEcho("can you help me find a way to Rome")).toBeNull();
    expect(tripRouteEcho("track a flight to Nairobi")).toBeNull();
    expect(tripRouteEcho("from my house to the airport")).toBeNull();
  });

  it("stays quiet when there is no route to repeat", () => {
    expect(tripRouteEcho("")).toBeNull();
    expect(tripRouteEcho("   ")).toBeNull();
    expect(tripRouteEcho("September 6")).toBeNull();
    expect(tripRouteEcho("why is it better?")).toBeNull();
    expect(tripRouteEcho("yes")).toBeNull();
    expect(tripRouteEcho("to")).toBeNull();
    expect(tripRouteEcho("Lagos to")).toBeNull();
    expect(tripRouteEcho("to London")).toBeNull();
  });

  it("never echoes more than a place name's worth of words", () => {
    const echo = tripRouteEcho(
      "Lagos Nigeria West Africa Somewhere to London England Great Britain Somewhere"
    );
    expect(echo).toBe("Lagos Nigeria West to London England Great");
  });
});

describe("opening acknowledgement", () => {
  it("names their route when they gave one", () => {
    expect(captainOpeningStatus("Lagos to London in September", "message-1"))
      .toContain("Lagos to London");
  });

  it("falls back to a varied acknowledgement rather than guessing", () => {
    const openings = Array.from({ length: 20 }, (_, index) =>
      captainOpeningStatus("I want to fly to Lagos", `message-${index}`)
    );
    expect(new Set(openings).size).toBe(CAPTAIN_OPENING_STATUS_VARIANTS.length);
    expect(openings.every((opening) => !opening.includes("Lagos"))).toBe(true);
    expect(captainOpeningStatus("find me a cheap flight", "message-1"))
      .not.toMatch(/got it/iu);
  });

  it("claims nothing about what the search will find", () => {
    const opening = captainOpeningStatus("Lagos to London in September");
    expect(opening).not.toMatch(/found|cheap|best|available|price|\$/iu);
    expect(opening).toMatch(/…$/u);
  });
});
