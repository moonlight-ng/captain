import { describe, expect, it } from "vitest";

import {
  createCaptainAccessLink,
  createCaptainAccessToken,
  resolveCaptainAccessToken
} from "../src/index.js";

describe("Captain design access links", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const secret = "telegram-bot-secret";

  it("creates a reusable direct link without an exchange or expiry", () => {
    const first = createCaptainAccessLink("https://captain.example", "/trip", userId, secret);
    const second = createCaptainAccessLink("https://captain.example", "/trip", userId, secret);
    expect(first).toBe(second);
    const url = new URL(first);
    expect(url.pathname).toBe("/trip");
    expect(url.hash).toMatch(/^#access=/u);
    const token = new URLSearchParams(url.hash.slice(1)).get("access")!;
    expect(resolveCaptainAccessToken(token, secret)).toBe(userId);
    expect(resolveCaptainAccessToken(token, "different-secret")).toBeNull();
  });

  it("rejects altered access tokens", () => {
    const token = createCaptainAccessToken(userId, secret);
    expect(resolveCaptainAccessToken(`${token}x`, secret)).toBeNull();
    expect(resolveCaptainAccessToken("not-a-token", secret)).toBeNull();
  });
});
