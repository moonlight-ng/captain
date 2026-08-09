import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { CaptainAdminAuth } from "../services/admin/auth.js";

describe("Captain administrator authentication", () => {
  it("returns 401 semantics for a missing bearer token", async () => {
    const auth = createAuth(vi.fn());
    expect(await auth.authenticate(new Request("https://captain.example/api/admin/session")))
      .toEqual({ status: "unauthorized" });
  });

  it("verifies the JWT and matches allowlisted email case-insensitively", async () => {
    const getUser = vi.fn(async () => ({
      data: { user: { id: "admin-1", email: "ADMIN@EXAMPLE.COM" } },
      error: null
    }));
    const auth = createAuth(getUser);
    const result = await auth.authenticate(requestWithToken("valid-token"));

    expect(getUser).toHaveBeenCalledWith("valid-token");
    expect(result).toEqual({
      status: "authenticated",
      identity: { id: "admin-1", email: "admin@example.com" }
    });
  });

  it("separates invalid identities from authenticated non-admin users", async () => {
    const invalid = createAuth(vi.fn(async () => ({ data: { user: null }, error: new Error("expired") })));
    expect(await invalid.authenticate(requestWithToken("expired"))).toEqual({ status: "unauthorized" });

    const outsider = createAuth(vi.fn(async () => ({
      data: { user: { id: "user-2", email: "other@example.com" } },
      error: null
    })));
    expect(await outsider.authenticate(requestWithToken("valid"))).toEqual({ status: "forbidden" });
  });

  it("exposes only browser-safe identity configuration", () => {
    const auth = createAuth(vi.fn());
    expect(auth.publicConfig()).toEqual({
      supabaseUrl: "https://captain.supabase.co",
      supabasePublishableKey: "sb_publishable_captain"
    });
    expect(JSON.stringify(auth.publicConfig())).not.toContain("admin@example.com");
  });
});

function createAuth(getUser: ReturnType<typeof vi.fn>): CaptainAdminAuth {
  const client = { auth: { getUser } } as unknown as SupabaseClient;
  return new CaptainAdminAuth({
    url: "https://captain.supabase.co",
    publishableKey: "sb_publishable_captain",
    allowedEmails: ["Admin@Example.com"],
    client
  });
}

function requestWithToken(token: string): Request {
  return new Request("https://captain.example/api/admin/session", {
    headers: { authorization: `Bearer ${token}` }
  });
}
