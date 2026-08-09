-- Migration 017 added normalized multi-city tables after the runtime roles
-- were configured. Objects created by the migration login do not inherit the
-- group role's default privileges, so explicitly secure and grant them here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'captain_runtime') then
    create role captain_runtime nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'captain_migrator') then
    create role captain_migrator nologin;
  end if;
end
$$;

grant usage on schema captain to captain_runtime, captain_migrator;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'trip_cities',
    'trip_legs',
    'leg_search_snapshots'
  ]
  loop
    execute format('alter table captain.%I enable row level security', table_name);
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'captain'
        and tablename = table_name
        and policyname = 'captain_runtime_full_access'
    ) then
      execute format(
        'create policy captain_runtime_full_access on captain.%I for all to captain_runtime using (true) with check (true)',
        table_name
      );
    end if;
    execute format(
      'grant select, insert, update, delete on captain.%I to captain_runtime',
      table_name
    );
    execute format('alter table captain.%I owner to captain_migrator', table_name);
  end loop;
end
$$;
