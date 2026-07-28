-- Allow one-shot inventory coverage notices when Duffel returns no offers.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'captain'
    and rel.relname = 'notifications'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%kind%';

  if constraint_name is not null then
    execute format('alter table captain.notifications drop constraint %I', constraint_name);
  end if;
end $$;

alter table captain.notifications
  add constraint notifications_kind_check
  check (kind in (
    'initial_results',
    'price_drop',
    'new_best',
    'watch_attention',
    'inventory_gap'
  ));
