import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Traveller facts migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/027_traveller_facts.sql"),
    "utf8"
  );

  it("creates durable facts with evidence and a dismissible status", () => {
    expect(migration).toContain("create table captain.traveller_facts");
    expect(migration).toContain("'home_airport'");
    expect(migration).toContain("'cabin_preference'");
    expect(migration).toContain("'airline_affinity'");
    expect(migration).toContain("'routine_route'");
    expect(migration).toContain("'constraint'");
    expect(migration).toContain("'context'");
    expect(migration).toContain("evidence text not null");
    expect(migration).toContain("'active'");
    expect(migration).toContain("'dismissed'");
    expect(migration).toContain("unique (user_id, kind, value)");
  });

  it("grants the runtime role and scopes RLS to it", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("grant select, insert, update, delete on captain.traveller_facts to captain_runtime");
  });
});
