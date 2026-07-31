revoke create on schema public from captain_workflow;
revoke create on database postgres from captain_workflow;

revoke all on schema workflow, workflow_drizzle, captain_worker
from public, anon, authenticated;
grant usage, create on schema workflow, workflow_drizzle, captain_worker
to captain_workflow;

revoke all on schema captain from captain_workflow;
revoke all on schema workflow, workflow_drizzle, captain_worker
from captain_runtime;
alter role captain_workflow set search_path = workflow, public;
