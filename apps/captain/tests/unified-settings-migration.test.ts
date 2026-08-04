import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Unified settings route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/007_unified_settings_route.sql"),
    "utf8"
  );

  it("allows login tokens to target the canonical settings route", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain(
      "check (redirect_path in ('/trip', '/preferences', '/settings', '/payment', '/travellers'))"
    );
  });
});
