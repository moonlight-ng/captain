import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { buildSearchSpecs, tripBriefSchema } from "@agents/flight-domain";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

const sql = postgres(databaseUrl, { max: 1 });
try {
  const [migrationTable] = await sql<{ table_name: string | null }[]>`
    select to_regclass('flight_agent.schema_migrations')::text as table_name
  `;
  if (!migrationTable?.table_name) {
    throw new Error("flight_agent.schema_migrations is not provisioned; apply the base schema with an administrator connection first");
  }
  const migrationDirectory = resolve("migrations");
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const applied = await sql<{ version: string }[]>`
      select version from flight_agent.schema_migrations where version = ${file}
    `;
    if (applied.length > 0) continue;
    const body = await readFile(resolve(migrationDirectory, file), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(body);
      await transaction`
        insert into flight_agent.schema_migrations (version) values (${file})
        on conflict (version) do nothing
      `;
    });
    console.info(`Applied ${file}`);
  }
  await backfillTripSearchSpecs();
  await reconcileLegacyMigration();
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
  const liveMode = process.env.DUFFEL_LIVE_MODE?.trim().toLowerCase() === "true";
  for (const trip of trips) {
    const specs = buildSearchSpecs(tripBriefSchema.parse(trip.brief), liveMode);
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

async function reconcileLegacyMigration(): Promise<void> {
  const [counts] = await sql<Array<{ agents: string; aliases: string; observations: string; migrated_observations: string }>>`
    select
      (select count(*)::text from flight_agent.agents) as agents,
      (select count(*)::text from captain.legacy_agent_aliases) as aliases,
      (select count(*)::text from flight_agent.price_observations) as observations,
      (select count(*)::text from captain.price_observations where search_run_id is null) as migrated_observations
  `;
  if (!counts || counts.agents !== counts.aliases || counts.observations !== counts.migrated_observations) {
    throw new Error(`Captain legacy migration reconciliation failed: ${JSON.stringify(counts ?? {})}`);
  }
  console.info(`Reconciled ${counts.agents} legacy Trips and ${counts.observations} price observations`);
}
