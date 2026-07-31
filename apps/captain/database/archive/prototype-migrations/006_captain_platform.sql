create extension if not exists pgcrypto;
create schema if not exists captain;

create table if not exists captain.users (
  id uuid primary key,
  status text not null check (status in ('active', 'suspended')),
  timezone text not null default 'UTC',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.telegram_accounts (
  telegram_user_id bigint primary key,
  user_id uuid not null unique references captain.users(id) on delete cascade,
  chat_id bigint not null,
  username text,
  first_name text,
  last_name text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);

create table if not exists captain.telegram_updates (
  update_key text primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  processed_at timestamptz not null
);

create table if not exists captain.conversations (
  id uuid primary key,
  user_id uuid not null unique references captain.users(id) on delete cascade,
  summary text not null default '',
  active_trip_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.messages (
  id uuid primary key,
  conversation_id uuid not null references captain.conversations(id) on delete cascade,
  user_id uuid not null references captain.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  created_at timestamptz not null
);
create index if not exists captain_messages_conversation_created_idx
  on captain.messages (conversation_id, created_at desc);

create table if not exists captain.memory_facts (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  fact_key text not null,
  value jsonb not null,
  scope text not null check (scope in ('profile', 'travel', 'trip')),
  source_message_id uuid not null references captain.messages(id) on delete cascade,
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  confirmed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id, scope, fact_key)
);

create table if not exists captain.trips (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  legacy_agent_key text unique,
  title text not null check (char_length(title) between 1 and 120),
  status text not null check (status in ('draft', 'tracking', 'recommended', 'paused', 'cancelled', 'completed')),
  version integer not null check (version > 0),
  brief jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists captain_trips_user_updated_idx on captain.trips (user_id, updated_at desc);

alter table captain.conversations
  drop constraint if exists captain_conversations_active_trip_id_fkey;
alter table captain.conversations
  add constraint captain_conversations_active_trip_id_fkey
  foreign key (active_trip_id) references captain.trips(id) on delete set null;

create table if not exists captain.trip_events (
  id uuid primary key,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  user_id uuid not null references captain.users(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  source_message_id uuid references captain.messages(id) on delete set null,
  created_at timestamptz not null
);
create index if not exists captain_trip_events_trip_created_idx on captain.trip_events (trip_id, created_at desc);

create table if not exists captain.watches (
  id uuid primary key,
  trip_id uuid not null unique references captain.trips(id) on delete cascade,
  status text not null check (status in ('active', 'paused', 'completed')),
  cadence_hours integer not null check (cadence_hours between 1 and 24),
  next_check_at timestamptz,
  last_check_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists captain_watches_due_idx on captain.watches (next_check_at)
  where status = 'active' and next_check_at is not null;

create table if not exists captain.search_specs (
  id text primary key,
  spec_key text not null unique,
  provider text not null check (provider = 'duffel'),
  request jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.watch_search_specs (
  watch_id uuid not null references captain.watches(id) on delete cascade,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  created_at timestamptz not null,
  primary key (watch_id, search_spec_id)
);
create index if not exists captain_watch_search_specs_spec_idx on captain.watch_search_specs (search_spec_id);

create table if not exists captain.search_runs (
  id uuid primary key,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  attempt integer not null default 0 check (attempt between 0 and 3),
  claimed_by text,
  lease_expires_at timestamptz,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  provider_request_id text,
  error text,
  created_at timestamptz not null
);
create index if not exists captain_search_runs_claim_idx
  on captain.search_runs (scheduled_at)
  where status = 'queued' or status = 'running';
create unique index if not exists captain_search_runs_one_live_idx
  on captain.search_runs (search_spec_id)
  where status in ('queued', 'running');

create table if not exists captain.itineraries (
  itinerary_key text primary key,
  segments jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.offers (
  id uuid primary key,
  search_run_id uuid not null references captain.search_runs(id) on delete cascade,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  itinerary_key text not null references captain.itineraries(itinerary_key),
  provider text not null check (provider = 'duffel'),
  provider_offer_id text not null,
  provider_search_id text not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null check (char_length(currency) = 3),
  expires_at timestamptz,
  observed_at timestamptz not null,
  snapshot jsonb not null,
  unique (search_run_id, provider_offer_id)
);
create index if not exists captain_offers_spec_observed_idx on captain.offers (search_spec_id, observed_at desc);
create index if not exists captain_offers_itinerary_observed_idx on captain.offers (itinerary_key, observed_at desc);

create table if not exists captain.price_observations (
  id uuid primary key,
  search_run_id uuid references captain.search_runs(id) on delete cascade,
  search_spec_id text references captain.search_specs(id) on delete cascade,
  itinerary_key text not null,
  provider text not null,
  provider_offer_id text not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null check (char_length(currency) = 3),
  observed_at timestamptz not null,
  snapshot jsonb not null
);
create index if not exists captain_price_history_idx on captain.price_observations (itinerary_key, observed_at desc);

create table if not exists captain.trip_recommendations (
  trip_id uuid primary key references captain.trips(id) on delete cascade,
  offer_id uuid not null references captain.offers(id) on delete cascade,
  itinerary_key text not null,
  score numeric(14, 4) not null,
  price numeric(12, 2) not null,
  currency text not null,
  summary text not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.notifications (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  kind text not null check (kind in ('initial_results', 'price_drop', 'new_best', 'watch_attention')),
  dedup_key text not null unique,
  payload jsonb not null,
  status text not null check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null,
  delivered_at timestamptz,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists captain_notifications_pending_idx on captain.notifications (available_at)
  where status = 'pending';

create table if not exists captain.audit_events (
  id uuid primary key,
  user_id uuid references captain.users(id) on delete set null,
  trip_id uuid references captain.trips(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create table if not exists captain.legacy_agent_aliases (
  legacy_agent_key text primary key,
  trip_id uuid not null unique references captain.trips(id) on delete cascade,
  created_at timestamptz not null
);

-- Existing private Flight Agent data belongs to the dedicated Pilot principal.
insert into captain.users (id, status, timezone, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000001', 'active', 'Europe/London', now(), now())
on conflict (id) do nothing;

insert into captain.conversations (id, user_id, summary, active_trip_id, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', '', null, now(), now())
on conflict (user_id) do nothing;

insert into captain.trips (
  id, user_id, legacy_agent_key, title, status, version, brief,
  created_at, updated_at
)
select
  gen_random_uuid(),
  '00000000-0000-4000-8000-000000000001'::uuid,
  agent.agent_key,
  concat_ws(' ', agent.brief->'originAirports'->>0, 'to', agent.brief->'destinationAirports'->>0),
  case when agent.status = 'paused' then 'paused' else 'tracking' end,
  greatest(agent.version, 1),
  agent.brief,
  agent.created_at,
  agent.updated_at
from flight_agent.agents agent
on conflict (legacy_agent_key) do nothing;

insert into captain.watches (
  id, trip_id, status, cadence_hours, next_check_at, last_check_at, created_at, updated_at
)
select
  gen_random_uuid(), trip.id,
  case when trip.status = 'paused' then 'paused' else 'active' end,
  agent.cadence_hours, agent.next_check_at, agent.last_check_at,
  agent.created_at, agent.updated_at
from captain.trips trip
join flight_agent.agents agent on agent.agent_key = trip.legacy_agent_key
on conflict (trip_id) do nothing;

insert into captain.legacy_agent_aliases (legacy_agent_key, trip_id, created_at)
select legacy_agent_key, id, now()
from captain.trips
where legacy_agent_key is not null
on conflict (legacy_agent_key) do nothing;

insert into captain.itineraries (itinerary_key, segments, created_at, updated_at)
select flight.itinerary_key, coalesce(link.latest_snapshot->'segments', '[]'::jsonb), flight.created_at, flight.updated_at
from flight_agent.flights flight
left join lateral (
  select latest_snapshot from flight_agent.agent_flights link
  where link.flight_id = flight.id order by last_seen_at desc limit 1
) link on true
on conflict (itinerary_key) do nothing;

insert into captain.price_observations (
  id, search_run_id, search_spec_id, itinerary_key, provider,
  provider_offer_id, price, currency, observed_at, snapshot
)
select
  observation.id, null, null, flight.itinerary_key, observation.source,
  observation.source_offer_id, observation.price, observation.currency,
  observation.observed_at, observation.snapshot
from flight_agent.price_observations observation
join flight_agent.flights flight on flight.id = observation.flight_id
on conflict (id) do nothing;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'users', 'telegram_accounts', 'telegram_updates', 'conversations', 'messages',
    'memory_facts', 'trips', 'trip_events', 'watches', 'search_specs',
    'watch_search_specs', 'search_runs', 'itineraries', 'offers',
    'price_observations', 'trip_recommendations', 'notifications',
    'audit_events', 'legacy_agent_aliases'
  ] loop
    execute format('alter table captain.%I enable row level security', table_name);
    if to_regrole('anon') is not null then
      execute format('revoke all on captain.%I from anon', table_name);
    end if;
    if to_regrole('authenticated') is not null then
      execute format('revoke all on captain.%I from authenticated', table_name);
    end if;
  end loop;
end
$$;
