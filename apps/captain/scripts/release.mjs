import { spawn } from "node:child_process";

import postgres from "postgres";

await run(process.execPath, ["--import", "tsx", "scripts/migrate.ts"]);

const configuredUrl = process.env.WORKFLOW_POSTGRES_URL?.trim();
if (!configuredUrl) throw new Error("WORKFLOW_POSTGRES_URL is required");

const inspectionUrl = new URL(configuredUrl);
inspectionUrl.searchParams.delete("uselibpqcompat");
const sql = postgres(inspectionUrl.href, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 2
});

let ready;
try {
  [ready] = await sql`
    select
      to_regclass('workflow.workflow_runs') is not null as world,
      to_regclass('workflow_drizzle.workflow_migrations') is not null as migrations,
      to_regclass('captain_worker.migrations') is not null as queue
  `;
} finally {
  await sql.end({ timeout: 2 });
}

if (ready?.world && ready.migrations && ready.queue) {
  process.stdout.write("Workflow schemas already bootstrapped; release check passed.\n");
} else {
  process.stdout.write("Workflow schemas are blank or incomplete; running bootstrap.\n");
  await run("bootstrap", []);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
      } else {
        resolve();
      }
    });
  });
}
