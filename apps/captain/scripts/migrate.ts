import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { buildSearchSpecs, tripBriefSchema } from "@agents/flight-domain";

const databaseUrl = (
  process.env.MIGRATION_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || ""
);
if (!databaseUrl) {
  throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required for migrations");
}

// Installing the baseline into a database that has no Captain project is an
// explicit opt-in: without it the sentinel check stays the guard that stops a
// migration run from landing in some other product's database.
const allowBaseline = ["1", "true", "yes", "on"].includes(
  process.env.CAPTAIN_ALLOW_BASELINE?.trim().toLowerCase() ?? ""
);

const sql = postgres(databaseUrl, { max: 1 });
try {
  const established = await captainProjectExists();
  if (established) {
    await assertCaptainSentinel();
  } else if (allowBaseline) {
    console.info("No Captain project found. Applying the baseline to a fresh database.");
  } else {
    throw new Error(
      "No Captain project found at MIGRATION_DATABASE_URL. "
      + "Set CAPTAIN_ALLOW_BASELINE=1 to install the baseline into a fresh database."
    );
  }
  const applied = established ? await appliedVersions() : new Set<string>();
  const migrationDirectory = resolve("database/migrations");
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(resolve(migrationDirectory, file), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(body);
      // The baseline is what creates the captain schema, so the ledger can
      // only be guaranteed to exist once a migration body has run.
      await transaction`
        create table if not exists captain.schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `;
      await transaction`
        insert into captain.schema_migrations (version) values (${file})
        on conflict (version) do nothing
      `;
    });
    console.info(`Applied ${file}`);
  }
  // A freshly baselined database must end up as a valid Captain v1 project.
  if (!established) await assertCaptainSentinel();
  await backfillTripSearchSpecs();
  await reconcileActiveTripSearchSpecs();
} finally {
  await sql.end({ timeout: 5 });
}

async function captainProjectExists(): Promise<boolean> {
  const [row] = await sql<Array<{ present: boolean }>>`
    select to_regclass('captain.project_meta') is not null as present
  `;
  return row?.present === true;
}

async function assertCaptainSentinel(): Promise<void> {
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
}

async function appliedVersions(): Promise<Set<string>> {
  await sql`
    create table if not exists captain.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const rows = await sql<Array<{ version: string }>>`
    select version from captain.schema_migrations
  `;
  return new Set(rows.map((row) => row.version));
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
