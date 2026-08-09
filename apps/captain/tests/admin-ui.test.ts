import { describe, expect, it } from "vitest";

import { parseAdminRoute } from "../src/admin/routing.js";

describe("Captain administrator routing", () => {
  it.each([
    ["/admin", { page: "overview" }],
    ["/admin/", { page: "overview" }],
    ["/admin/conversations", { page: "conversations" }],
    ["/admin/conversations/", { page: "conversations" }],
    ["/admin/costs", { page: "costs" }],
    ["/admin/conversations/user%20conversation", { page: "conversation", id: "user conversation" }]
  ])("maps %s into the isolated administrator application", (pathname, expected) => {
    expect(parseAdminRoute(pathname as string)).toEqual(expected);
  });
});
