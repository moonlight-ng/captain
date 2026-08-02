import { describe, expect, it } from "vitest";

import { legacyBearerAllowed } from "../services/auth/legacy-bearer.js";

describe("legacyBearerAllowed", () => {
  it("allows the session and profile/trip design-link surfaces", () => {
    expect(legacyBearerAllowed("GET", "/api/auth/session")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/profile")).toBe(true);
    expect(legacyBearerAllowed("PATCH", "/api/me/profile")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/trip")).toBe(true);
    expect(legacyBearerAllowed("PATCH", "/api/me/trip")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/actions")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/selections")).toBe(true);
  });

  it("denies passengers, payments, account, and trip travellers", () => {
    expect(legacyBearerAllowed("GET", "/api/me/passengers")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/passengers")).toBe(false);
    expect(legacyBearerAllowed("GET", "/api/me/payments")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/payments/methods")).toBe(false);
    expect(legacyBearerAllowed("DELETE", "/api/me/account")).toBe(false);
    expect(legacyBearerAllowed("GET", "/api/me/trip/travellers")).toBe(false);
    expect(legacyBearerAllowed("PUT", "/api/me/trip/travellers")).toBe(false);
  });
});
