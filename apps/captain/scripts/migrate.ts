import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { buildSearchSpecs, tripBriefSchema } from "@agents/flight-domain";

const databaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("MIGRATION_DATABASE_URL is required for migrations");
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  const [project] = await sql<Array<{
    project_kind: string;
    schema_version: number;
  }>>`
    select project_kind, schema_version
    from captain.project_meta
    where singleton = true
  `;
  if (project?.project_kind !== "captain" || project.schema_version !== 1) {
    throw new Error("Captain database sentinel mismatch");
  }
  await sql`
    create table if not exists captain.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const migrationDirectory = resolve("database/migrations");
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
  await reconcileActiveTripSearchSpecs();
} finally {
  await sql.end({ timeout: 5 });
}

async function reconcileActiveTripSearchSpecs(): Promise<void> {
  const trips = await sql<Array<{ trip_id: string; watch_id: string; brief: unknown }>>`
    select trip.id as trip_id, watch.id as watch_id, trip.brief
    from captain.trips trip
    join captain.watches watch on watch.trip_id = trip.id
    where trip.status not in ('cancelled', 'completed', 'archived')
      and watch.status <> 'completed'
  `;
  let reconciled = 0;
  for (const trip of trips) {
    const [spec] = buildSearchSpecs(tripBriefSchema.parse(trip.brief));
    if (!spec) continue;
    const existing = await sql<Array<{ search_spec_id: string }>>`
      select search_spec_id from captain.watch_search_specs
      where watch_id = ${trip.watch_id}
    `;
    if (existing.length === 1 && existing[0]?.search_spec_id === spec.id) continue;
    await sql.begin(async (transaction) => {
      await transaction`
        insert into captain.search_specs (id, spec_key, provider, request, created_at, updated_at)
        values (
          ${spec.id}, ${spec.key}, ${spec.request.provider},
          ${transaction.json(spec.request as never)}, now(), now()
        )
        on conflict (id) do update set
          provider = excluded.provider,
          request = excluded.request,
          updated_at = excluded.updated_at
      `;
      await transaction`
        insert into captain.watch_search_specs (watch_id, search_spec_id, created_at)
        values (${trip.watch_id}, ${spec.id}, now())
        on conflict do nothing
      `;
      await transaction`
        delete from captain.watch_search_specs
        where watch_id = ${trip.watch_id}
          and search_spec_id <> ${spec.id}
      `;
      await transaction`
        update captain.watches
        set next_check_at = now(), delayed_at = null, delay_reason = null, updated_at = now()
        where id = ${trip.watch_id}
      `;
    });
    reconciled += 1;
  }
  if (reconciled > 0) {
    console.info(`Reconciled Duffel search specifications for ${reconciled} active trips`);
  }
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
  if (trips.length > 0) console.info(`Backfilled search specifications for ${trips.length} trips`);
}
