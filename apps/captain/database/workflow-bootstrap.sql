-- @workflow/world-postgres creates its own Workflow and migration-ledger
-- schemas, plus temporary public enums in early migrations. Grant only the
-- bootstrap privileges it requires, then immediately apply workflow-harden.sql.
grant create on database postgres to captain_workflow;
grant usage, create on schema public to captain_workflow;
