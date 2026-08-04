import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Profile route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/008_profile_route.sql"),
    "utf8"
  );

  it("allows secure login tokens to target the canonical profile route", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain(
      "check (redirect_path in ('/trip', '/profile', '/preferences', '/settings', '/payment', '/travellers'))"
    );
  });
});
