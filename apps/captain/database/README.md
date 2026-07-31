# Captain database

`migrations/001_captain_baseline.sql` is the only executable Captain schema
history for a fresh project. The former prototype chain remains in
`archive/prototype-migrations/` as a read-only archive and is never scanned by
the migrator.

Apply the baseline with an admin or migration login, then apply `roles.sql`
with the project owner. Use separate login roles for:

- `MIGRATION_DATABASE_URL` → member of `captain_migrator`
- `DATABASE_URL` → member of `captain_runtime`
- `WORKFLOW_POSTGRES_URL` → member of `captain_workflow`

Never give the Workflow login membership in `captain_runtime`.
