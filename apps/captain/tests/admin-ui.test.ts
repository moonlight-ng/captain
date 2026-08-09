import { describe, expect, it } from "vitest";

import { parseAdminRoute } from "../src/admin/routing.js";

describe("Captain administrator routing", () => {
  it.each([
    ["/admin", { page: "overview" }],
    ["/admin/", { page: "overview" }],
    ["/admin/conversations", { page: "conversations" }],
    ["/admin/conversations/", { page: "conversations" }],
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
