import { describe, expect, it } from "vitest";

import {
  checkpointNotificationKindForAction,
  isCheckpointEventType,
  isCheckpointNotificationKind,
  isMaterialTripPlanChange,
  isSpokenCheckpointEventType
} from "@agents/flight-domain";

import { defaultTestBrief } from "./support.js";

describe("trip checkpoints", () => {
  it("classifies checkpoint event and notification kinds", () => {
    expect(isCheckpointEventType("trip_plan_changed")).toBe(true);
    expect(isCheckpointEventType("trip_created")).toBe(false);
    expect(isCheckpointEventType("telegram_message")).toBe(false);
    expect(isCheckpointNotificationKind("plan_changed")).toBe(true);
    expect(isCheckpointNotificationKind("inventory_gap")).toBe(false);
    expect(isSpokenCheckpointEventType("captain_update")).toBe(true);
    expect(isSpokenCheckpointEventType("trip_pause")).toBe(false);
  });

  it("detects material plan changes and ignores context-only edits", () => {
    const base = defaultTestBrief();
    expect(isMaterialTripPlanChange(base, {
      ...base,
      destinationAirports: ["CDG"]
    })).toBe(true);
    expect(isMaterialTripPlanChange(base, { ...base })).toBe(false);
    // Freeform context is intentionally outside the material fingerprint.
    const contextOnly = {
      ...base,
      context: "Window seat if possible"
    };
    expect(isMaterialTripPlanChange(base, contextOnly)).toBe(false);
  });

  it("maps actions onto notify kinds", () => {
    expect(checkpointNotificationKindForAction("pause")).toBe("tracking_paused");
    expect(checkpointNotificationKindForAction("resume")).toBe("tracking_resumed");
    expect(checkpointNotificationKindForAction("plan_changed")).toBe("plan_changed");
    expect(checkpointNotificationKindForAction("cancel")).toBe("trip_closed");
    expect(checkpointNotificationKindForAction("replaced")).toBe("trip_closed");
  });
});
