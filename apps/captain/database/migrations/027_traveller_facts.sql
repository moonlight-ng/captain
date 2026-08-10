-- Durable knowledge about the traveller, as opposed to the rolling summary of
-- the current conversation. A summary decays with the chat; a fact — home
-- airport, cabin habit, a standing constraint — outlives the trip it was
-- learned on and should still be true three trips later.
--
-- captain.traveller_profiles cannot hold these: every column there is a typed
-- setting with a check constraint, deliberately.
--
-- `evidence` is the load-bearing column. Captain already refuses any model-
-- proposed trip operation whose evidence is not a literal substring of what the
-- traveller said (sanitizeModelPatch); facts obey the same rule, so a fact
-- always has a quote behind it and can be shown for review rather than
-- silently applied. Assumptions the traveller cannot see are the failure this
-- whole feature is most likely to reproduce.

create table captain.traveller_facts (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  kind text not null check (kind in (
    'home_airport', 'cabin_preference', 'airline_affinity',
    'routine_route', 'constraint', 'context'
  )),
  value text not null check (char_length(value) between 1 and 300),
  evidence text not null check (char_length(evidence) between 1 and 500),
  source_message_id uuid references captain.messages(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'dismissed')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  -- One row per thing learned. Re-learning the same fact updates it rather
  -- than stacking duplicates into the agent's context every turn.
  unique (user_id, kind, value)
);

create index captain_traveller_facts_active_idx
  on captain.traveller_facts (user_id, kind)
  where status = 'active';

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
alter table captain.traveller_facts enable row level security;
create policy captain_runtime_full_access on captain.traveller_facts
  for all to captain_runtime using (true) with check (true);
grant select, insert, update, delete on captain.traveller_facts to captain_runtime;
alter table captain.traveller_facts owner to captain_migrator;
