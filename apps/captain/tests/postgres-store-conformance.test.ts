import { afterAll, beforeAll, describe, expect, it } from "vitest";

import postgres from "postgres";
import { PostgresCaptainPlatformStore } from "@agents/flight-store";
import { describeCaptainPlatformStore } from "@agents/flight-store/test-conformance";

/**
 * Runs the shared store contract against real Postgres.
 *
 * This lives in apps/captain rather than in @agents/flight-store because
 * Captain owns the schema and its migrations. Point
 * CAPTAIN_TEST_DATABASE_URL at a disposable, already-migrated database:
 * every table in the captain schema is truncated between tests.
 */
const databaseUrl = process.env.CAPTAIN_TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  describe("PostgresCaptainPlatformStore", () => {
    it.skip("needs CAPTAIN_TEST_DATABASE_URL pointing at a disposable database", () => {});
  });
} else {
  const sql = postgres(databaseUrl, { max: 1 });
  const store = PostgresCaptainPlatformStore.connect(databaseUrl, 4);

  beforeAll(async () => {
    const [sentinel] = await sql<Array<{ present: boolean }>>`
      select to_regclass('captain.project_meta') is not null as present
    `;
    if (sentinel?.present !== true) {
      throw new Error(
        "CAPTAIN_TEST_DATABASE_URL has no Captain schema. Run db:migrate against it first."
      );
    }
  });

  afterAll(async () => {
    await store.close();
    await sql.end({ timeout: 5 });
  });

  describeCaptainPlatformStore("PostgresCaptainPlatformStore", async () => {
    await truncateCaptainTables();
    return store;
  });

  async function truncateCaptainTables(): Promise<void> {
    // The sentinel and the migration ledger describe the schema itself, so
    // they survive; everything else is per-test state.
    const tables = await sql<Array<{ name: string }>>`
      select tablename as name
      from pg_tables
      where schemaname = 'captain'
        and tablename not in ('project_meta', 'schema_migrations')
    `;
    if (tables.length === 0) return;
    const targets = tables
      .map((table) => `captain."${table.name.replaceAll('"', '""')}"`)
      .join(", ");
    await sql.unsafe(`truncate table ${targets} restart identity cascade`);
  }
}
