alter table flight_agent.flights
  add column if not exists itinerary_key text;

update flight_agent.flights
set itinerary_key = 'legacy:' || id::text
where itinerary_key is null;

alter table flight_agent.flights
  alter column itinerary_key set not null;

do $$
declare
  legacy_constraint text;
begin
  select constraint_row.conname into legacy_constraint
  from pg_constraint as constraint_row
  where constraint_row.conrelid = 'flight_agent.flights'::regclass
    and constraint_row.contype = 'u'
    and pg_get_constraintdef(constraint_row.oid) like 'UNIQUE (destination_iata, departure_local_date, marketing_carrier_code)%'
  limit 1;
  if legacy_constraint is not null then
    execute format('alter table flight_agent.flights drop constraint %I', legacy_constraint);
  end if;
end
$$;

create unique index if not exists flight_agent_flights_itinerary_key_idx
  on flight_agent.flights (itinerary_key);

alter table flight_agent.price_observations
  add column if not exists source text,
  add column if not exists source_offer_id text,
  add column if not exists booking_url text;

update flight_agent.price_observations
set
  source = coalesce(snapshot->>'provider', 'duffel'),
  source_offer_id = coalesce(snapshot->>'providerOfferId', id::text),
  booking_url = snapshot->>'bookingUrl'
where source is null or source_offer_id is null;

alter table flight_agent.price_observations
  alter column source set not null,
  alter column source_offer_id set not null;

do $$
declare
  legacy_constraint text;
begin
  select constraint_row.conname into legacy_constraint
  from pg_constraint as constraint_row
  where constraint_row.conrelid = 'flight_agent.price_observations'::regclass
    and constraint_row.contype = 'u'
    and pg_get_constraintdef(constraint_row.oid) like 'UNIQUE (agent_key, flight_id, check_id)%'
  limit 1;
  if legacy_constraint is not null then
    execute format('alter table flight_agent.price_observations drop constraint %I', legacy_constraint);
  end if;
end
$$;

create unique index if not exists flight_agent_observations_source_offer_idx
  on flight_agent.price_observations (
    agent_key, flight_id, check_id, source, source_offer_id
  );

alter table flight_agent.research_runs
  add column if not exists offers jsonb not null default '[]'::jsonb;

create table if not exists flight_agent.check_source_runs (
  check_id uuid not null references flight_agent.checks(id) on delete cascade,
  source text not null check (source in ('duffel', 'codex_web')),
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  offers_found integer not null default 0,
  observations_saved integer not null default 0,
  error text,
  primary key (check_id, source)
);
