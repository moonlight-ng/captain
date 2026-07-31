# Captain database

`migrations/001_captain_baseline.sql` is the fresh-project baseline; later
numbered files are forward-only production changes. The former prototype chain remains in
`archive/prototype-migrations/` as a read-only archive and is never scanned by
the migrator.

Apply the baseline with an admin or migration login, then apply `roles.sql`
with the project owner. Use separate login roles for:

- `MIGRATION_DATABASE_URL` → member of `captain_migrator`
- `DATABASE_URL` → member of `captain_runtime`
- `WORKFLOW_POSTGRES_URL` → member of `captain_workflow`

Never give the Workflow login membership in `captain_runtime`.

`scripts/migrate.ts` reads `MIGRATION_DATABASE_URL`, not `DATABASE_URL`. When
the target already holds a Captain project it verifies the
`captain.project_meta` sentinel before applying anything, so a migration run
cannot land in another product's database. Installing the baseline into a
database with no Captain project is a separate, explicit decision: set
`CAPTAIN_ALLOW_BASELINE=1`. Disposable test and evaluation databases are the
expected users of that flag; production never needs it after the first
install.

Before the first Workflow bootstrap, apply `workflow-bootstrap.sql` as the
project owner. Run the pinned `bootstrap` binary with the Workflow login, then
apply `workflow-claim-ownership.sql` as that login and immediately apply
`workflow-harden.sql` as the project owner. Later releases use
`scripts/release.mjs`, which only bootstraps when the Workflow schemas are
genuinely missing.
