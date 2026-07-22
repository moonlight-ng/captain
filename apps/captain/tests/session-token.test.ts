import { describe, expect, it } from "vitest";

import { issueCaptainSessionToken, verifyCaptainSessionToken } from "../agent/lib/session-token.js";

describe("Captain session tokens", () => {
  it("authenticates the signed user without trusting a client user id", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const token = issueCaptainSessionToken({ secret: "secret", userId, now: 1_000, ttlMs: 5_000, nonce: "0123456789abcdef" });
    expect(verifyCaptainSessionToken(token, "secret", 2_000)).toBe(userId);
    expect(verifyCaptainSessionToken(token, "wrong", 2_000)).toBeNull();
    expect(verifyCaptainSessionToken(token, "secret", 6_001)).toBeNull();
  });
});
