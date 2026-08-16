import { describe, expect, it } from "vitest";

import { AdminApiError, loadErrorCopy } from "../src/admin/api.js";
import { automationScheduleLabel, automationStatusLabel, tripResultStatusLabel } from "../src/admin/automation-copy.js";
import { parseAdminRoute } from "../src/admin/routing.js";

describe("Captain administrator routing", () => {
  it.each([
    ["/admin", { page: "overview" }],
    ["/admin/", { page: "overview" }],
    ["/admin/conversations", { page: "conversations" }],
    ["/admin/conversations/", { page: "conversations" }],
    ["/admin/automations", { page: "automations" }],
    ["/admin/automations/", { page: "automations" }],
    ["/admin/trips", { page: "trips" }],
    ["/admin/trips/", { page: "trips" }],
    ["/admin/costs", { page: "costs" }],
    ["/admin/settings", { page: "settings" }],
    ["/admin/conversations/user%20conversation", { page: "conversation", id: "user conversation" }],
    ["/admin/trips/11111111-1111-4111-8111-111111111111", { page: "trip", id: "11111111-1111-4111-8111-111111111111" }]
  ])("maps %s into the isolated administrator application", (pathname, expected) => {
    expect(parseAdminRoute(pathname as string)).toEqual(expected);
  });
});

describe("administrator automation copy", () => {
  it("shows an active fare digest instead of the trip recommendation state", () => {
    expect(automationStatusLabel({ purpose: "fare_digest", status: "active" }))
      .toBe("Daily digest active");
    expect(automationScheduleLabel({
      purpose: "fare_digest",
      digestHourLocal: 9,
      digestTimeZone: "Africa/Lagos"
    })).toBe("Daily at 09:00 · Africa/Lagos");
    expect(tripResultStatusLabel("recommended")).toBe("Recommendation ready");
  });

  it("keeps price-change watches and inactive states explicit", () => {
    expect(automationStatusLabel({ purpose: "price_changes", status: "paused" }))
      .toBe("Price tracking paused");
    expect(automationScheduleLabel({
      purpose: "price_changes",
      digestHourLocal: null,
      digestTimeZone: null
    })).toBe("Every 24 hours");
  });
});

describe("administrator load errors", () => {
  it("keeps authentication failures distinct from server and network failures", () => {
    expect(loadErrorCopy(new AdminApiError(401, "session_expired"))).toEqual({
      title: "Production data couldn’t be loaded.",
      body: "Your session may have expired."
    });
    expect(loadErrorCopy(new AdminApiError(500, "database_error"))).toEqual({
      title: "Production data couldn’t be loaded.",
      body: "The server returned 500 (database_error)."
    });
    expect(loadErrorCopy(new AdminApiError(404, "not_found"))).toEqual({
      title: "That production record isn’t available.",
      body: "It may have been removed, or this Captain server may not have the requested API yet."
    });
    expect(loadErrorCopy(new TypeError("fetch failed"))).toEqual({
      title: "Production data couldn’t be loaded.",
      body: "Captain couldn’t reach the production API. Check the connection and try again."
    });
  });
});
