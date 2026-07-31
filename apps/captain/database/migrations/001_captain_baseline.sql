create extension if not exists pgcrypto;
create schema if not exists captain;

create table captain.project_meta (
  singleton boolean primary key default true check (singleton),
  project_kind text not null unique check (project_kind = 'captain'),
  schema_version integer not null check (schema_version > 0),
  installed_at timestamptz not null default now()
);

insert into captain.project_meta (singleton, project_kind, schema_version)
values (true, 'captain', 1);

create table captain.users (
  id uuid primary key,
  status text not null check (status in ('active', 'suspended')),
  timezone text not null default 'UTC',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table captain.telegram_accounts (
  telegram_user_id bigint primary key,
  user_id uuid not null unique references captain.users(id) on delete cascade,
  chat_id bigint not null,
  username text,
  first_name text,
  last_name text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);

create table captain.telegram_updates (
  update_key text primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  processed_at timestamptz not null
);

create table captain.conversations (
  id uuid primary key,
  user_id uuid not null unique references captain.users(id) on delete cascade,
  summary text not null default '',
  active_trip_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table captain.messages (
  id uuid primary key,
  conversation_id uuid not null references captain.conversations(id) on delete cascade,
  user_id uuid not null references captain.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  created_at timestamptz not null
);

create index captain_messages_conversation_created_idx
  on captain.messages (conversation_id, created_at desc);

create table captain.trips (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  status text not null check (
    status in ('draft', 'tracking', 'recommended', 'paused', 'cancelled', 'completed', 'archived')
  ),
  version integer not null check (version > 0),
  brief jsonb not null,
  archived_at timestamptz,
  archive_reason text check (archive_reason is null or archive_reason in ('replaced', 'user')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index captain_trips_user_updated_idx on captain.trips (user_id, updated_at desc);

alter table captain.conversations
  add constraint captain_conversations_active_trip_id_fkey
  foreign key (active_trip_id) references captain.trips(id) on delete set null;

create table captain.trip_events (
  id uuid primary key,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  user_id uuid not null references captain.users(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  source_message_id uuid references captain.messages(id) on delete set null,
  created_at timestamptz not null
);

create index captain_trip_events_trip_created_idx on captain.trip_events (trip_id, created_at desc);

create table captain.watches (
  id uuid primary key,
  trip_id uuid not null unique references captain.trips(id) on delete cascade,
  status text not null check (status in ('active', 'scheduled', 'paused', 'completed')),
  cadence_hours integer not null check (cadence_hours between 1 and 24),
  next_check_at timestamptz,
  last_check_at timestamptz,
  delayed_at timestamptz,
  delay_reason text,
  last_manual_refresh_at timestamptz,
  tracking_starts_at timestamptz,
  baseline_completed_at timestamptz,
  activated_at timestamptz,
  last_user_activity_at timestamptz not null,
  check_in_sent_at timestamptz,
  auto_pause_at timestamptz,
  price_rise_itinerary_key text,
  price_rise_armed boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index captain_watches_due_idx on captain.watches (next_check_at)
  where status in ('active', 'scheduled') and next_check_at is not null;

create table captain.search_specs (
  id text primary key,
  spec_key text not null unique,
  provider text not null check (provider = 'openai_web' or provider ~ '^official_[a-z0-9_]+$'),
  request jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table captain.watch_search_specs (
  watch_id uuid not null references captain.watches(id) on delete cascade,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  created_at timestamptz not null,
  primary key (watch_id, search_spec_id)
);

create index captain_watch_search_specs_spec_idx
  on captain.watch_search_specs (search_spec_id);

create table captain.search_runs (
  id uuid primary key,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'deferred')),
  attempt integer not null default 0 check (attempt between 0 and 3),
  claimed_by text,
  lease_expires_at timestamptz,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  provider_request_id text,
  error text,
  provider_offer_count integer check (provider_offer_count is null or provider_offer_count >= 0),
  retained_offer_count integer check (retained_offer_count is null or retained_offer_count >= 0),
  created_at timestamptz not null
);

create index captain_search_runs_claim_idx
  on captain.search_runs (scheduled_at)
  where status in ('queued', 'running');
create unique index captain_search_runs_one_live_idx
  on captain.search_runs (search_spec_id)
  where status in ('queued', 'running');
create index captain_search_runs_completed_idx
  on captain.search_runs (completed_at)
  where status in ('completed', 'failed', 'deferred');

create table captain.itineraries (
  itinerary_key text primary key,
  segments jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table captain.offers (
  id uuid primary key,
  search_run_id uuid not null references captain.search_runs(id) on delete cascade,
  search_spec_id text not null references captain.search_specs(id) on delete cascade,
  itinerary_key text not null references captain.itineraries(itinerary_key),
  provider text not null check (provider = 'openai_web' or provider ~ '^official_[a-z0-9_]+$'),
  provider_offer_id text not null,
  provider_search_id text not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null check (char_length(currency) = 3),
  expires_at timestamptz,
  observed_at timestamptz not null,
  snapshot jsonb not null,
  fare_basis text not null default 'one_adult_total',
  primary_airline_code text not null default 'UNK',
  participating_airline_codes jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  discovery_response_id text not null default '',
  verification_response_id text not null default '',
  prompt_version text not null default '',
  model text not null default '',
  verified_at timestamptz not null default now(),
  unique (search_run_id, provider_offer_id)
);

create index captain_offers_spec_observed_idx on captain.offers (search_spec_id, observed_at desc);
create index captain_offers_itinerary_observed_idx on captain.offers (itinerary_key, observed_at desc);
create index captain_offers_spec_price_idx on captain.offers (search_spec_id, price, observed_at desc);

create table captain.price_observations (
  id uuid primary key,
  search_run_id uuid references captain.search_runs(id) on delete set null,
  search_spec_id text references captain.search_specs(id) on delete set null,
  itinerary_key text not null,
  provider text not null,
  provider_offer_id text not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null check (char_length(currency) = 3),
  observed_at timestamptz not null,
  snapshot jsonb not null
);

create index captain_price_history_idx on captain.price_observations (itinerary_key, observed_at desc);
create index captain_price_observations_observed_idx on captain.price_observations (observed_at);

create table captain.trip_recommendations (
  trip_id uuid primary key references captain.trips(id) on delete cascade,
  offer_id uuid references captain.offers(id) on delete set null,
  search_spec_id text references captain.search_specs(id) on delete set null,
  itinerary_key text not null,
  score numeric(14, 4) not null,
  price numeric(12, 2) not null,
  currency text not null,
  summary text not null,
  ranking_mode text not null default 'balanced'
    check (ranking_mode in ('cheapest', 'balanced', 'fastest')),
  snapshot jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  updated_at timestamptz not null
);

create index captain_trip_recommendations_search_spec_idx
  on captain.trip_recommendations (search_spec_id)
  where search_spec_id is not null;

create table captain.trip_flight_selections (
  trip_id uuid not null references captain.trips(id) on delete cascade,
  itinerary_key text not null,
  selected_by text not null check (selected_by in ('agent', 'person')),
  selected_at timestamptz not null,
  primary key (trip_id, itinerary_key, selected_by)
);

create index captain_trip_flight_selections_trip_selected_idx
  on captain.trip_flight_selections (trip_id, selected_at desc);

create table captain.notifications (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  kind text not null check (kind in (
    'initial_results', 'price_drop', 'new_best', 'watch_attention', 'inventory_gap',
    'daily_digest', 'price_rise', 'tracking_activation', 'tracking_checkin', 'tracking_paused'
  )),
  dedup_key text not null unique,
  payload jsonb not null,
  status text not null check (status in ('pending', 'sending', 'sent', 'failed', 'superseded')),
  attempts integer not null default 0,
  available_at timestamptz not null,
  delivered_at timestamptz,
  telegram_message_id bigint,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index captain_notifications_pending_idx on captain.notifications (available_at)
  where status = 'pending';
create unique index captain_notifications_telegram_message_idx
  on captain.notifications (user_id, telegram_message_id)
  where telegram_message_id is not null;

create table captain.audit_events (
  id uuid primary key,
  user_id uuid references captain.users(id) on delete set null,
  trip_id uuid references captain.trips(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create table captain.trip_plan_drafts (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  status text not null check (
    status in ('collecting', 'awaiting_confirmation', 'starting', 'started', 'cancelled', 'expired')
  ),
  revision integer not null check (revision > 0),
  conversation jsonb not null default '[]'::jsonb,
  partial jsonb not null,
  plan jsonb,
  unresolved_fields jsonb not null default '[]'::jsonb,
  inferred_fields jsonb not null default '{}'::jsonb,
  source_message_ids jsonb not null default '[]'::jsonb,
  turn_state jsonb not null default '{
    "version": 2,
    "pendingFields": [],
    "lastPrompt": null,
    "repeatedPromptCount": 0,
    "fieldSources": {},
    "interpreterVersion": "trip_interpreter_v2",
    "parser": null,
    "model": null,
    "lastIntent": null,
    "lastOperations": []
  }'::jsonb,
  trip_id uuid references captain.trips(id) on delete set null,
  create_idempotency_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null
);

create unique index captain_trip_plan_drafts_one_open_idx
  on captain.trip_plan_drafts (user_id)
  where status in ('collecting', 'awaiting_confirmation', 'starting');
create index captain_trip_plan_drafts_expiry_idx
  on captain.trip_plan_drafts (expires_at)
  where status in ('collecting', 'awaiting_confirmation', 'starting');
create unique index captain_trip_plan_drafts_trip_idx
  on captain.trip_plan_drafts (trip_id)
  where trip_id is not null;
create unique index captain_trip_plan_drafts_idempotency_idx
  on captain.trip_plan_drafts (create_idempotency_key)
  where create_idempotency_key is not null;

create table captain.traveller_profiles (
  user_id uuid primary key references captain.users(id) on delete cascade,
  default_currency text not null check (default_currency ~ '^[A-Z]{3}$'),
  ranking_mode text not null check (ranking_mode in ('cheapest', 'balanced', 'fastest')),
  preferred_airline_codes jsonb not null default '[]'::jsonb,
  excluded_airline_codes jsonb not null default '[]'::jsonb,
  onboarding_step text not null check (
    onboarding_step in ('welcome', 'currency', 'ranking', 'airlines', 'complete')
  ),
  onboarding_completed_at timestamptz,
  alerts_enabled boolean not null default true,
  max_alerts_per_day integer not null default 2 check (max_alerts_per_day between 1 and 2),
  quiet_hours_enabled boolean not null default true,
  quiet_hours_start integer not null default 22,
  quiet_hours_end integer not null default 7,
  notification_mode text not null default 'smart'
    check (notification_mode in ('smart', 'daily', 'changes_only', 'off')),
  digest_hour_local integer not null default 9 check (digest_hour_local between 0 and 23),
  price_rise_alerts_enabled boolean not null default true,
  better_option_alerts_enabled boolean not null default true,
  tracking_checkins_enabled boolean not null default true,
  last_digest_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (quiet_hours_start between 0 and 23 and quiet_hours_end between 0 and 23)
);

create table captain.login_tokens (
  token_hash text primary key check (char_length(token_hash) = 64),
  user_id uuid not null references captain.users(id) on delete cascade,
  redirect_path text not null check (redirect_path in ('/trip', '/preferences')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null
);

create index captain_login_tokens_expiry_idx
  on captain.login_tokens (expires_at) where consumed_at is null;

create table captain.web_sessions (
  token_hash text primary key check (char_length(token_hash) = 64),
  user_id uuid not null references captain.users(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null,
  last_seen_at timestamptz not null
);

create index captain_web_sessions_user_idx on captain.web_sessions (user_id, expires_at desc);

create table captain.api_usage_days (
  usage_date date primary key,
  response_count integer not null default 0 check (response_count >= 0),
  web_search_call_count integer not null default 0 check (web_search_call_count >= 0),
  updated_at timestamptz not null
);

create function captain.compact_offer_snapshot()
returns trigger
language plpgsql
as $$
begin
  new.snapshot = jsonb_strip_nulls(jsonb_build_object(
    'route', left(coalesce(new.snapshot ->> 'route', ''), 300),
    'airlineCodes', coalesce(new.snapshot -> 'airlineCodes', '[]'::jsonb),
    'flightNumbers', coalesce(new.snapshot -> 'flightNumbers', '[]'::jsonb),
    'stops', coalesce(new.snapshot -> 'stops', '0'::jsonb),
    'durationSeconds', coalesce(new.snapshot -> 'durationSeconds', '0'::jsonb),
    'conditions', coalesce(new.snapshot -> 'conditions', '{}'::jsonb),
    'segments', coalesce(new.snapshot -> 'segments', '[]'::jsonb)
  ));
  return new;
end
$$;

create trigger captain_offers_compact_snapshot
before insert or update of snapshot on captain.offers
for each row execute function captain.compact_offer_snapshot();

create function captain.compact_price_observation()
returns trigger
language plpgsql
as $$
begin
  new.snapshot = '{}'::jsonb;
  return new;
end
$$;

create trigger captain_price_observations_compact
before insert or update of snapshot on captain.price_observations
for each row execute function captain.compact_price_observation();

create function captain.enforce_price_history_run_limit()
returns trigger
language plpgsql
as $$
begin
  if new.search_run_id is not null then
    delete from captain.price_observations observation
    where observation.id in (
      select candidate.id
      from captain.price_observations candidate
      where candidate.search_run_id = new.search_run_id
      order by candidate.price, candidate.observed_at desc, candidate.id
      offset 25
    );
  end if;
  return null;
end
$$;

create trigger captain_price_observations_limit_run
after insert on captain.price_observations
for each row execute function captain.enforce_price_history_run_limit();

create function captain.maintain_watch_retention()
returns trigger
language plpgsql
as $$
begin
  delete from captain.price_observations
  where observed_at < now() - interval '90 days';

  delete from captain.offers
  where observed_at < now() - interval '7 days'
     or (expires_at is not null and expires_at <= now());

  delete from captain.search_runs
  where id <> new.id
    and status in ('completed', 'failed', 'deferred')
    and completed_at < now() - interval '7 days';

  delete from captain.itineraries itinerary
  where not exists (
    select 1 from captain.offers offer
    where offer.itinerary_key = itinerary.itinerary_key
  );
  return null;
end
$$;

create trigger captain_search_runs_maintain_retention
after insert on captain.search_runs
for each row execute function captain.maintain_watch_retention();

create function captain.enforce_active_trip_limit()
returns trigger
language plpgsql
as $$
declare
  active_trip_count integer;
begin
  if new.status in ('cancelled', 'completed', 'archived') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  select count(*) into active_trip_count
  from captain.trips trip
  where trip.user_id = new.user_id
    and trip.id <> new.id
    and trip.status not in ('cancelled', 'completed', 'archived');

  if active_trip_count >= 3 then
    raise exception 'A traveller may have at most 3 active Trips'
      using errcode = 'check_violation',
        constraint = 'captain_trips_max_three_active';
  end if;
  return new;
end
$$;

create trigger captain_trips_enforce_active_limit
before insert or update of user_id, status on captain.trips
for each row execute function captain.enforce_active_trip_limit();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'project_meta', 'users', 'telegram_accounts', 'telegram_updates',
    'conversations', 'messages', 'trips', 'trip_events', 'watches',
    'search_specs', 'watch_search_specs', 'search_runs', 'itineraries',
    'offers', 'price_observations', 'trip_recommendations',
    'trip_flight_selections', 'notifications', 'audit_events',
    'trip_plan_drafts', 'traveller_profiles', 'login_tokens',
    'web_sessions', 'api_usage_days'
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
