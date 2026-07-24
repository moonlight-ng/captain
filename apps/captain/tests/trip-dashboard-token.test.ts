import { describe, expect, it } from "vitest";

import {
  issueCompactTripDashboardToken,
  issueTripDashboardToken,
  tripDashboardUrl,
  verifyCompactTripDashboardToken,
  verifyTripDashboardToken
} from "../services/auth/trip-dashboard-token.js";

describe("Trip dashboard tokens", () => {
  it("binds access to one user and one Trip and rejects tampering and expiry", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const tripId = "22222222-2222-4222-8222-222222222222";
    const token = issueTripDashboardToken({
      secret: "secret",
      userId,
      tripId,
      now: 1_000,
      ttlMs: 5_000,
      nonce: "0123456789abcdef"
    });
    expect(verifyTripDashboardToken(token, "secret", 2_000)).toMatchObject({ userId, tripId });
    expect(verifyTripDashboardToken(token, "wrong", 2_000)).toBeNull();
    expect(verifyTripDashboardToken(`${token}x`, "secret", 2_000)).toBeNull();
    expect(verifyTripDashboardToken(token, "secret", 6_001)).toBeNull();
  });

  it("authenticates a compact Trip-scoped token", () => {
    const tripId = "22222222-2222-4222-8222-222222222222";
    const token = issueCompactTripDashboardToken({
      secret: "secret",
      tripId,
      now: 1_000,
      ttlMs: 5_000
    });
    expect(token.length).toBeLessThan(60);
    expect(verifyCompactTripDashboardToken(token, "secret", 2_000)).toMatchObject({ tripId });
    expect(verifyCompactTripDashboardToken(token, "wrong", 2_000)).toBeNull();
    expect(verifyCompactTripDashboardToken(token, "secret", 6_001)).toBeNull();
  });

  it("places the compact signed credential in a short URL fragment", () => {
    const url = tripDashboardUrl({
      publicUrl: "https://captain.example/",
      secret: "secret",
      userId: "11111111-1111-4111-8111-111111111111",
      tripId: "22222222-2222-4222-8222-222222222222"
    });
    expect(url).toMatch(/^https:\/\/captain\.example\/t#[A-Za-z0-9_.-]+$/u);
    expect(url.length).toBeLessThan(100);
    expect(new URL(url).search).toBe("");
  });
});
