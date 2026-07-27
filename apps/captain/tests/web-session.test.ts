import { describe, expect, it } from "vitest";

import { CaptainWebAuth } from "../services/auth/web-session.js";

describe("Captain design links", () => {
  it("uses the same reusable direct link for Trip and settings access", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const auth = new CaptainWebAuth({
      publicUrl: "https://captain.example",
      secret: "telegram-bot-secret"
    });
    const link = auth.createAccessLink(userId, "/preferences");
    expect(new URL(link).pathname).toBe("/preferences");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("access")!;
    const request = new Request("https://captain.example/api/auth/session", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(auth.resolve(request)).toBe(userId);
    expect(auth.createAccessLink(userId, "/preferences")).toBe(link);
    expect(auth.resolve(new Request("https://captain.example/api/auth/session"))).toBeNull();
  });
});
