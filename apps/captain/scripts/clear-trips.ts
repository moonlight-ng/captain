/**
 * Clears every trip in a Captain database, so travellers start from nothing.
 *
 * This is destructive and not scoped to one traveller: it removes all trips,
 * their tracking state, and the shared search data behind them. Accounts,
 * profiles and preferences survive — a traveller keeps their settings and can
 * describe a new trip immediately.
 *
 * Dry run by default. It prints what it would delete and exits without
 * writing; pass --apply to commit.
 *
 *   node --env-file=.env --import tsx scripts/clear-trips.ts
 *   node --env-file=.env --import tsx scripts/clear-trips.ts --apply
 */
import postgres from "postgres";

import { assertCaptainDatabase } from "../services/app/project-guard.js";

const apply = process.argv.includes("--apply");
const databaseUrl = (
  process.env.MIGRATION_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || ""
);
if (!databaseUrl) {
  throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required");
}

// Refuses to run against anything that is not the Captain project.
await assertCaptainDatabase(databaseUrl);

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15 });

try {
  const before = await counts();
  console.info(apply ? "Clearing trips." : "Dry run. Nothing will be written.");
  for (const [table, n] of Object.entries(before)) {
    console.info(`  ${table.padEnd(24)} ${n}`);
  }

  if (!apply) {
    console.info("\nRe-run with --apply to delete these rows.");
  } else {
    await sql.begin(async (tx) => {
      // Trips cascade into watches, recommendations, selections, trip events
      // and notifications. Conversations null their active trip.
      await tx`delete from captain.trips`;
      await tx`delete from captain.trip_plan_drafts`;

      // Search specs are shared between trips rather than owned by one, so
      // they outlive the cascade. Left behind, a new trip on the same route
      // would adopt the old spec and open with stale offers and a price
      // history the traveller never watched.
      await tx`delete from captain.price_observations`;
      await tx`delete from captain.offers`;
      await tx`delete from captain.search_runs`;
      await tx`delete from captain.search_specs`;
      await tx`delete from captain.itineraries`;

      // Alerts about trips that no longer exist.
      await tx`delete from captain.notifications`;
    });

    const after = await counts();
    console.info("\nRemaining:");
    for (const [table, n] of Object.entries(after)) {
      console.info(`  ${table.padEnd(24)} ${n}`);
    }
    const [users] = await sql`select count(*)::int as n from captain.users`;
    const [profiles] = await sql`select count(*)::int as n from captain.traveller_profiles`;
    console.info(`\nKept ${users!.n} traveller(s) and ${profiles!.n} profile(s).`);
  }
} finally {
  await sql.end({ timeout: 5 });
}

async function counts(): Promise<Record<string, number>> {
  const [row] = await sql<Array<Record<string, number>>>`
    select
      (select count(*)::int from captain.trips) as trips,
      (select count(*)::int from captain.watches) as watches,
      (select count(*)::int from captain.trip_plan_drafts) as trip_plan_drafts,
      (select count(*)::int from captain.trip_flight_selections) as flight_selections,
      (select count(*)::int from captain.search_specs) as search_specs,
      (select count(*)::int from captain.search_runs) as search_runs,
      (select count(*)::int from captain.offers) as offers,
      (select count(*)::int from captain.price_observations) as price_observations,
      (select count(*)::int from captain.itineraries) as itineraries,
      (select count(*)::int from captain.notifications) as notifications
  `;
  return row!;
}
