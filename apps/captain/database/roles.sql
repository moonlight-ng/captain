-- Group roles deliberately have no login. Create a unique login for each
-- process, grant it one group role, and store that login's URL separately.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'captain_runtime') then
    create role captain_runtime nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'captain_migrator') then
    create role captain_migrator nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'captain_workflow') then
    create role captain_workflow nologin;
  end if;
end
$$;

grant captain_migrator, captain_workflow to postgres;
grant connect on database postgres to captain_runtime, captain_migrator, captain_workflow;

grant usage on schema captain to captain_runtime;
grant select, insert, update, delete on all tables in schema captain to captain_runtime;
grant usage, select on all sequences in schema captain to captain_runtime;
grant execute on all functions in schema captain to captain_runtime;
alter default privileges in schema captain
  grant select, insert, update, delete on tables to captain_runtime;
alter default privileges in schema captain
  grant usage, select on sequences to captain_runtime;

do $$
declare table_name text;
begin
  for table_name in
    select tablename from pg_tables where schemaname = 'captain'
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'captain'
        and tablename = table_name
        and policyname = 'captain_runtime_full_access'
    ) then
      continue;
    end if;
    execute format(
      'create policy captain_runtime_full_access on captain.%I for all to captain_runtime using (true) with check (true)',
      table_name
    );
  end loop;
end
$$;

grant usage, create on schema captain to captain_migrator;
grant all privileges on all tables in schema captain to captain_migrator;
grant all privileges on all sequences in schema captain to captain_migrator;
grant execute on all functions in schema captain to captain_migrator;
alter default privileges in schema captain grant all on tables to captain_migrator;
alter default privileges in schema captain grant all on sequences to captain_migrator;
alter default privileges in schema captain grant execute on functions to captain_migrator;

alter role captain_workflow set search_path = workflow, public;

revoke all on schema captain from captain_workflow;

alter schema captain owner to captain_migrator;

do $$
declare
  relation record;
  routine record;
begin
  for relation in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'captain'
  loop
    execute format(
      'alter table %I.%I owner to captain_migrator',
      relation.schemaname,
      relation.tablename
    );
  end loop;

  for routine in
    select
      namespace.nspname as schema_name,
      procedure.proname as routine_name,
      pg_get_function_identity_arguments(procedure.oid) as identity_arguments
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'captain'
  loop
    execute format(
      'alter function %I.%I(%s) owner to captain_migrator',
      routine.schema_name,
      routine.routine_name,
      routine.identity_arguments
    );
  end loop;
end
$$;

alter default privileges for role captain_migrator in schema captain
  grant select, insert, update, delete on tables to captain_runtime;
alter default privileges for role captain_migrator in schema captain
  grant usage, select on sequences to captain_runtime;
alter default privileges for role captain_migrator in schema captain
  grant execute on functions to captain_runtime;
