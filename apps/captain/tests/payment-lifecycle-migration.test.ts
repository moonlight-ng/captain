import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Payment card lifecycle migration", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "database/migrations/005_payment_card_lifecycle.sql"
  ), "utf8");

  it("drops fabricated expiry columns and enforces one active card after backfill", () => {
    expect(migration).toContain("drop column expiry_month");
    expect(migration).toContain("drop column expiry_year");
    expect(migration).toContain("drop index if exists captain.captain_payment_methods_one_default_idx");
    expect(migration).toContain("create unique index captain_payment_methods_one_active_idx");
    expect(migration).toContain("where status = 'active'");
    const backfillAt = migration.indexOf("Backfill BEFORE the one-active unique index");
    const indexAt = migration.indexOf("create unique index captain_payment_methods_one_active_idx");
    expect(backfillAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(backfillAt);
  });

  it("caps payment method rows at twenty and creates setup intents", () => {
    expect(migration).toContain("captain_payment_methods_max_twenty");
    expect(migration).toContain("if method_count >= 20 then");
    expect(migration).toContain("create table captain.payment_card_setup_intents");
    expect(migration).toContain("captain_payment_card_setup_intents_one_pending_idx");
    expect(migration).toContain("where status = 'pending'");
  });

  it("creates a leased remote deletion queue without a user FK", () => {
    expect(migration).toContain("create table captain.payment_card_deletions");
    expect(migration).toContain("unique (provider, provider_card_id)");
    expect(migration).toContain("captain_payment_card_deletions_claim_idx");
    const deletionsTable = migration.match(
      /create table captain\.payment_card_deletions \([\s\S]*?\);/u
    )?.[0] ?? "";
    expect(deletionsTable).toContain("provider_card_id text not null");
    expect(deletionsTable).not.toMatch(/user_id/u);
  });

  it("enables RLS and captain_runtime_full_access for the new tables", () => {
    for (const table of ["payment_card_setup_intents", "payment_card_deletions"]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain("alter table captain.%I enable row level security");
    expect(migration).toContain(
      "create policy captain_runtime_full_access on captain.%I for all to captain_runtime using (true) with check (true)"
    );
  });
});
