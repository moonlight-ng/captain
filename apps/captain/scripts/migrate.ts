import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { buildSearchSpecs, tripBriefSchema } from "@agents/flight-domain";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql`create schema if not exists captain`;
  await sql`
    create table if not exists captain.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const legacyLedger = await sql<Array<{ ledger: string | null }>>`
    select to_regclass('flight_agent.schema_migrations')::text as ledger
  `;
  if (legacyLedger[0]?.ledger) {
    await sql.unsafe(`
      insert into captain.schema_migrations (version, applied_at)
      select version, applied_at from flight_agent.schema_migrations
      on conflict (version) do nothing
    `);
  }
  const migrationDirectory = resolve("migrations");
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const applied = await sql<{ version: string }[]>`
      select version from captain.schema_migrations where version = ${file}
    `;
    if (applied.length > 0) continue;
    const body = await readFile(resolve(migrationDirectory, file), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(body);
      await transaction`
        insert into captain.schema_migrations (version) values (${file})
        on conflict (version) do nothing
      `;
    });
    console.info(`Applied ${file}`);
  }
  await backfillTripSearchSpecs();
} finally {
  await sql.end({ timeout: 5 });
}

async function backfillTripSearchSpecs(): Promise<void> {
  const trips = await sql<Array<{ trip_id: string; watch_id: string; brief: unknown }>>`
    select trip.id as trip_id, watch.id as watch_id, trip.brief
    from captain.trips trip
    join captain.watches watch on watch.trip_id = trip.id
    where not exists (
      select 1 from captain.watch_search_specs link where link.watch_id = watch.id
    )
  `;
  for (const trip of trips) {
    const specs = buildSearchSpecs(tripBriefSchema.parse(trip.brief));
    await sql.begin(async (transaction) => {
      for (const spec of specs) {
        await transaction`
          insert into captain.search_specs (id, spec_key, provider, request, created_at, updated_at)
          values (${spec.id}, ${spec.key}, ${spec.request.provider}, ${transaction.json(spec.request as never)}, now(), now())
          on conflict (id) do update set request = excluded.request, updated_at = excluded.updated_at
        `;
        await transaction`
          insert into captain.watch_search_specs (watch_id, search_spec_id, created_at)
          values (${trip.watch_id}, ${spec.id}, now()) on conflict do nothing
        `;
      }
    });
  }
  if (trips.length > 0) console.info(`Backfilled search specifications for ${trips.length} Trips`);
}
