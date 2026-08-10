import { describe, expect, it } from "vitest";

import { legacyBearerAllowed } from "../services/auth/legacy-bearer.js";

describe("legacyBearerAllowed", () => {
  it("allows the session and profile/trip design-link surfaces", () => {
    expect(legacyBearerAllowed("GET", "/api/auth/session")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/profile")).toBe(true);
    expect(legacyBearerAllowed("PATCH", "/api/me/profile")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/facts")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/trip")).toBe(true);
    expect(legacyBearerAllowed("PATCH", "/api/me/trip")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/actions")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/selections")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/legs/leg_1/searches")).toBe(true);
    expect(legacyBearerAllowed("GET", "/api/me/trip/legs/leg_1/searches/search_1")).toBe(true);
    expect(legacyBearerAllowed("POST", "/api/me/trip/legs/leg_1/selection")).toBe(true);
  });

  it("denies passengers, payments, account, and trip travellers", () => {
    expect(legacyBearerAllowed("GET", "/api/me/passengers")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/passengers")).toBe(false);
    expect(legacyBearerAllowed("GET", "/api/me/payments")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/payments/methods")).toBe(false);
    expect(legacyBearerAllowed("DELETE", "/api/me/account")).toBe(false);
    expect(legacyBearerAllowed("DELETE", "/api/me/facts/11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(legacyBearerAllowed("GET", "/api/me/trip/travellers")).toBe(false);
    expect(legacyBearerAllowed("PUT", "/api/me/trip/travellers")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/trip/legs/leg_1/searches/search_1")).toBe(false);
    expect(legacyBearerAllowed("GET", "/api/me/trip/legs/leg_1/selection")).toBe(false);
    expect(legacyBearerAllowed("POST", "/api/me/trip/legs//searches")).toBe(false);
  });
});
