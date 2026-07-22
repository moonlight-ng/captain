import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";

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
} finally {
  await sql.end({ timeout: 5 });
}
