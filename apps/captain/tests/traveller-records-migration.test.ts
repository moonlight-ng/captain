import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Traveller records and payments migration", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "database/migrations/004_traveller_records_and_payments.sql"
  ), "utf8");

  it("creates passenger, trip assignment, and payment method tables", () => {
    expect(migration).toContain("create table captain.passengers");
    expect(migration).toContain("create table captain.trip_passengers");
    expect(migration).toContain("create table captain.payment_methods");
    expect(migration).toContain("captain_passengers_max_eight");
    expect(migration).toContain("No PAN and no CVC is ever stored");
    expect(migration).toContain("add column traveller_setup_prompted_at");
  });

  it("widens the login token redirect allowlist to four session paths", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain(
      "check (redirect_path in ('/trip', '/preferences', '/payment', '/travellers'))"
    );
  });

  it("enables RLS and creates captain_runtime_full_access for each new table", () => {
    expect(migration).toContain("create role captain_runtime nologin");
    expect(migration).toContain("create role captain_migrator nologin");
    for (const table of ["passengers", "trip_passengers", "payment_methods"]) {
      expect(migration).toContain(`alter table captain.%I enable row level security`);
      expect(migration).toContain(
        "create policy captain_runtime_full_access on captain.%I for all to captain_runtime using (true) with check (true)"
      );
      expect(migration).toContain(`'${table}'`);
    }
  });
});
