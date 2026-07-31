import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres, { type Sql } from "postgres";

type Mode = "manifest" | "copy" | "verify";
type Row = Record<string, unknown>;
type TableSpec = {
  table: string;
  where?: string;
  select?: string;
  transform?: (row: Row) => Row;
};
type TableManifest = {
  table: string;
  rows: number;
  primaryKey: string[];
  primaryKeySha256: string;
  payloadSampleSha256: string[];
  maximumTimestamps: Record<string, string>;
};
type Manifest = {
  format: "captain-durable-migration/v1";
  generatedAt: string;
  sourceProject: "captain";
  tables: TableManifest[];
  foreignKeyViolations?: Array<{ constraint: string; violations: number }>;
};

const TERMINAL_RUN = "status in ('completed', 'failed', 'deferred')";
const TABLES: TableSpec[] = [
  { table: "users" },
  { table: "telegram_accounts" },
  { table: "traveller_profiles" },
  { table: "trips" },
  { table: "conversations" },
  { table: "messages" },
  { table: "trip_events" },
  { table: "watches" },
  { table: "search_specs" },
  { table: "watch_search_specs" },
  { table: "search_runs", where: TERMINAL_RUN },
  { table: "itineraries" },
  {
    table: "offers",
    where: `exists (
      select 1 from captain.search_runs retained_run
      where retained_run.id = offers.search_run_id
        and retained_run.${TERMINAL_RUN}
    )`
  },
  {
    table: "price_observations",
    where: `search_run_id is null or exists (
      select 1 from captain.search_runs retained_run
      where retained_run.id = price_observations.search_run_id
        and retained_run.${TERMINAL_RUN}
    )`
  },
  {
    table: "trip_recommendations",
    select: `trip_recommendations.*, case
      when trip_recommendations.offer_id is null then null
      when exists (
        select 1
        from captain.offers retained_offer
        join captain.search_runs retained_run on retained_run.id = retained_offer.search_run_id
        where retained_offer.id = trip_recommendations.offer_id
          and retained_run.${TERMINAL_RUN}
      ) then trip_recommendations.offer_id
      else null
    end as _migrated_offer_id`,
    transform: (row) => {
      const { _migrated_offer_id: migratedOfferId, ...copy } = row;
      return { ...copy, offer_id: migratedOfferId };
    }
  },
  { table: "trip_flight_selections" },
  { table: "notifications", where: "status in ('sent', 'failed', 'superseded')" },
  { table: "audit_events" },
  {
    table: "trip_plan_drafts",
    where: `status in ('collecting', 'awaiting_confirmation', 'starting')
      and expires_at > now()`
  },
  { table: "api_usage_days", where: "usage_date = current_date" }
];

const mode = process.argv[2] as Mode | undefined;
if (!mode || !["manifest", "copy", "verify"].includes(mode)) {
  throw new Error("Usage: migrate-durable-data.ts <manifest|copy|verify>");
}

const sourceUrl = required("SOURCE_CAPTAIN_DATABASE_URL");
const targetUrl = mode === "manifest" ? null : required("TARGET_CAPTAIN_DATABASE_URL");
if (targetUrl && sourceUrl === targetUrl) {
  throw new Error("Source and target Captain database URLs must be different");
}

const source = postgres(sourceUrl, { max: 1, idle_timeout: 2 });
const target = targetUrl ? postgres(targetUrl, { max: 1, idle_timeout: 2 }) : null;

try {
  await assertSourceProject(source);
  if (target) await assertTargetProject(target);

  const sourceManifest = await buildManifest(source);
  if (mode === "manifest") {
    await emitReport(mode, sourceManifest);
  } else if (mode === "copy" && target) {
    await copyTables(source, target);
    const targetManifest = await buildManifest(target);
    targetManifest.foreignKeyViolations = await foreignKeyViolations(target);
    assertEquivalent(sourceManifest, targetManifest);
    await emitReport(mode, targetManifest);
  } else if (mode === "verify" && target) {
    const targetManifest = await buildManifest(target);
    targetManifest.foreignKeyViolations = await foreignKeyViolations(target);
    assertEquivalent(sourceManifest, targetManifest);
    await emitReport(mode, targetManifest);
  }
} finally {
  await source.end({ timeout: 2 });
  await target?.end({ timeout: 2 });
}

async function assertSourceProject(sql: Sql): Promise<void> {
  const [row] = await sql<Array<{ users: string | null; trips: string | null }>>`
    select
      to_regclass('captain.users')::text as users,
      to_regclass('captain.trips')::text as trips
  `;
  if (!row?.users || !row.trips) {
    throw new Error("source database does not contain the Captain schema");
  }
}

async function assertTargetProject(sql: Sql): Promise<void> {
  const rows = await sql<Array<{ project_kind: string; schema_version: number }>>`
    select project_kind, schema_version from captain.project_meta where singleton = true
  `;
  if (rows.length !== 1 || rows[0]?.project_kind !== "captain" || rows[0].schema_version !== 1) {
    throw new Error("target database is not a Captain v1 project");
  }
}

async function copyTables(sourceSql: Sql, targetSql: Sql): Promise<void> {
  for (const spec of TABLES) {
    const rows = await selectRows(sourceSql, spec);
    if (rows.length === 0) continue;
    await targetSql.begin(async (transaction) => {
      await transaction.unsafe(
        `insert into captain.${quoteIdentifier(spec.table)}
         select * from jsonb_populate_recordset(
           null::captain.${quoteIdentifier(spec.table)}, $1::jsonb
         )
         on conflict do nothing`,
        [transaction.json(rows as never)]
      );
    });
    console.info(`Copied ${rows.length} Captain ${spec.table} rows`);
  }
}

async function buildManifest(sql: Sql): Promise<Manifest> {
  const tables: TableManifest[] = [];
  for (const spec of TABLES) {
    const rows = await selectRows(sql, spec);
    const primaryKey = await primaryKeyColumns(sql, spec.table);
    if (primaryKey.length === 0) throw new Error(`captain.${spec.table} has no primary key`);

    const primaryKeys = rows
      .map((row) => canonicalJson(primaryKey.map((column) => row[column])))
      .sort();
    const timestampColumns = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key.endsWith("_at")) timestampColumns.add(key);
      }
    }
    const maximumTimestamps: Record<string, string> = {};
    for (const column of timestampColumns) {
      const values = rows
        .map((row) => timestampString(row[column]))
        .filter((value): value is string => value !== null)
        .sort();
      if (values.length > 0) maximumTimestamps[column] = values.at(-1)!;
    }
    const canonicalRows = rows
      .map((row) => canonicalJson(row))
      .sort();
    const samples = canonicalRows.length === 0
      ? []
      : [canonicalRows[0]!, canonicalRows.at(-1)!];
    tables.push({
      table: spec.table,
      rows: rows.length,
      primaryKey,
      primaryKeySha256: sha256(primaryKeys.join("\n")),
      payloadSampleSha256: [...new Set(samples.map(sha256))],
      maximumTimestamps
    });
  }
  return {
    format: "captain-durable-migration/v1",
    generatedAt: new Date().toISOString(),
    sourceProject: "captain",
    tables
  };
}

async function selectRows(sql: Sql, spec: TableSpec): Promise<Row[]> {
  const select = spec.select ?? `${quoteIdentifier(spec.table)}.*`;
  const where = spec.where ? ` where ${spec.where}` : "";
  const result = await sql.unsafe<Row[]>(
    `select ${select} from captain.${quoteIdentifier(spec.table)}${where}`
  );
  return spec.transform ? result.map(spec.transform) : result;
}

async function primaryKeyColumns(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql<Array<{ column_name: string }>>`
    select attribute.attname as column_name
    from pg_index index
    join pg_class relation on relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join unnest(index.indkey) with ordinality key(attnum, ordering) on true
    join pg_attribute attribute
      on attribute.attrelid = relation.oid and attribute.attnum = key.attnum
    where namespace.nspname = 'captain'
      and relation.relname = ${table}
      and index.indisprimary
    order by key.ordering
  `;
  return rows.map((row) => row.column_name);
}

async function foreignKeyViolations(
  sql: Sql
): Promise<Array<{ constraint: string; violations: number }>> {
  const constraints = await sql<Array<{
    constraint_name: string;
    child_table: string;
    parent_table: string;
    child_columns: string[];
    parent_columns: string[];
  }>>`
    select
      constraint_record.conname as constraint_name,
      child.relname as child_table,
      parent.relname as parent_table,
      array_agg(child_attribute.attname order by child_key.ordering) as child_columns,
      array_agg(parent_attribute.attname order by child_key.ordering) as parent_columns
    from pg_constraint constraint_record
    join pg_class child on child.oid = constraint_record.conrelid
    join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
    join pg_class parent on parent.oid = constraint_record.confrelid
    join unnest(constraint_record.conkey) with ordinality child_key(attnum, ordering) on true
    join unnest(constraint_record.confkey) with ordinality parent_key(attnum, ordering)
      on parent_key.ordering = child_key.ordering
    join pg_attribute child_attribute
      on child_attribute.attrelid = child.oid and child_attribute.attnum = child_key.attnum
    join pg_attribute parent_attribute
      on parent_attribute.attrelid = parent.oid and parent_attribute.attnum = parent_key.attnum
    where constraint_record.contype = 'f'
      and child_namespace.nspname = 'captain'
    group by constraint_record.conname, child.relname, parent.relname
  `;

  const violations = [];
  for (const constraint of constraints) {
    const join = constraint.child_columns.map((column, index) =>
      `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(constraint.parent_columns[index]!)}`
    ).join(" and ");
    const populated = constraint.child_columns.map((column) =>
      `child.${quoteIdentifier(column)} is not null`
    ).join(" and ");
    const missing = `parent.${quoteIdentifier(constraint.parent_columns[0]!)} is null`;
    const [row] = await sql.unsafe<Array<{ count: string }>>(
      `select count(*)::text as count
       from captain.${quoteIdentifier(constraint.child_table)} child
       left join captain.${quoteIdentifier(constraint.parent_table)} parent on ${join}
       where ${populated} and ${missing}`
    );
    const count = Number(row?.count ?? 0);
    if (count > 0) {
      violations.push({ constraint: constraint.constraint_name, violations: count });
    }
  }
  return violations;
}

function assertEquivalent(sourceManifest: Manifest, targetManifest: Manifest): void {
  const failures: string[] = [];
  for (const sourceTable of sourceManifest.tables) {
    const targetTable = targetManifest.tables.find((entry) => entry.table === sourceTable.table);
    if (
      !targetTable
      || sourceTable.rows !== targetTable.rows
      || sourceTable.primaryKeySha256 !== targetTable.primaryKeySha256
    ) {
      failures.push(sourceTable.table);
    }
  }
  if ((targetManifest.foreignKeyViolations?.length ?? 0) > 0) {
    failures.push("foreign-key-checks");
  }
  if (failures.length > 0) {
    throw new Error(`Captain migration verification failed: ${failures.join(", ")}`);
  }
}

async function emitReport(modeName: Mode, manifest: Manifest): Promise<void> {
  const directory = resolve("database/reports");
  await mkdir(directory, { recursive: true });
  const stamp = manifest.generatedAt.replaceAll(":", "-");
  const path = resolve(directory, `${modeName}-${stamp}.json`);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(`Wrote ${path}`);
  console.info(JSON.stringify(manifest, null, 2));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}

function timestampString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
