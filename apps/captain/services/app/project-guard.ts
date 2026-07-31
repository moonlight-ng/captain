import postgres from "postgres";

export type CaptainProjectMeta = {
  project_kind: string;
  schema_version: number;
};

export function validateCaptainProjectMeta(rows: CaptainProjectMeta[]): void {
  const meta = rows[0];
  if (
    rows.length !== 1
    || meta?.project_kind !== "captain"
    || meta.schema_version !== 1
  ) {
    throw new Error(
      "Captain database guard failed: DATABASE_URL does not point to the Captain v1 project"
    );
  }
}

export async function assertCaptainDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2
  });
  try {
    const rows = await sql<CaptainProjectMeta[]>`
      select project_kind, schema_version
      from captain.project_meta
      where singleton = true
    `;
    validateCaptainProjectMeta(rows);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Captain database guard failed:")) {
      throw error;
    }
    throw new Error(
      "Captain database guard failed: DATABASE_URL does not point to a readable Captain v1 project",
      { cause: error }
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}
