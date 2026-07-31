import postgres from "postgres";

const databaseUrl = process.env.TARGET_CAPTAIN_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TARGET_CAPTAIN_DATABASE_URL is required");
}

const logins = [
  {
    name: "captain_runtime_login",
    group: "captain_runtime",
    password: process.env.CAPTAIN_RUNTIME_DATABASE_PASSWORD
  },
  {
    name: "captain_migration_login",
    group: "captain_migrator",
    password: process.env.CAPTAIN_MIGRATION_DATABASE_PASSWORD
  },
  {
    name: "captain_workflow_login",
    group: "captain_workflow",
    password: process.env.CAPTAIN_WORKFLOW_DATABASE_PASSWORD
  }
] as const;

const passwordPattern = /^[a-f0-9]{64}$/;
for (const login of logins) {
  if (!login.password || !passwordPattern.test(login.password)) {
    throw new Error(`${login.name} requires a 64-character hexadecimal password`);
  }
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  for (const login of logins) {
    await sql.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${login.name}') then
          create role ${login.name} login inherit;
        end if;
      end
      $$;
      alter role ${login.name} password '${login.password}';
      grant ${login.group} to ${login.name};
    `);
  }
  process.stdout.write("Captain runtime, migration, and Workflow login roles configured.\n");
} finally {
  await sql.end();
}
