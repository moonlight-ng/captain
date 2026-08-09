import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Multi-city runtime grants migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "database/migrations/019_grant_simplified_multi_city_runtime_access.sql"
    ),
    "utf8"
  );

  it("grants and secures every normalized multi-city table", () => {
    for (const table of ["trip_cities", "trip_legs", "leg_search_snapshots"]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain("alter table captain.%I enable row level security");
    expect(migration).toContain("create policy captain_runtime_full_access");
    expect(migration).toContain("grant select, insert, update, delete");
    expect(migration).toContain("alter table captain.%I owner to captain_migrator");
  });

  it("makes missing runtime table grants block a release", () => {
    const release = readFileSync(
      resolve(process.cwd(), "scripts/release.mjs"),
      "utf8"
    );
    expect(release).toContain("await assertRuntimeDatabasePermissions()");
    for (const privilege of ["select", "insert", "update", "delete"]) {
      expect(release).toContain(`has_table_privilege(relation.oid, '${privilege}')`);
    }
    expect(release).toContain("Captain runtime role is missing table privileges on:");
  });
});
