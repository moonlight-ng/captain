-- Captain 1.0 is a deliberate destructive cutover from the private prototype.
-- Existing Trip and legacy Flight Agent data is not carried into the public beta.

delete from captain.trips;
delete from captain.search_runs;
delete from captain.search_specs;
delete from captain.users where id = '00000000-0000-4000-8000-000000000001';

drop table if exists captain.legacy_agent_aliases cascade;
drop table if exists captain.memory_facts cascade;

alter table captain.trips
  drop constraint if exists trips_status_check;
alter table captain.trips
  add constraint trips_status_check
  check (status in ('draft', 'tracking', 'recommended', 'paused', 'cancelled', 'completed', 'archived'));
alter table captain.trips
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;
alter table captain.trips
  drop constraint if exists captain_trips_archive_reason_check;
alter table captain.trips
  add constraint captain_trips_archive_reason_check
  check (archive_reason is null or archive_reason in ('replaced', 'user'));
alter table captain.trips
  drop column if exists legacy_agent_key;

create unique index if not exists captain_trips_one_active_per_user_idx
  on captain.trips (user_id)
  where status not in ('cancelled', 'completed', 'archived');

alter table captain.watches
  add column if not exists delayed_at timestamptz,
  add column if not exists delay_reason text,
  add column if not exists last_manual_refresh_at timestamptz;

create table if not exists captain.traveller_profiles (
  user_id uuid primary key references captain.users(id) on delete cascade,
  default_currency text not null check (default_currency ~ '^[A-Z]{3}$'),
  ranking_mode text not null check (ranking_mode in ('cheapest', 'balanced', 'fastest')),
  preferred_airline_codes jsonb not null default '[]'::jsonb,
  excluded_airline_codes jsonb not null default '[]'::jsonb,
  onboarding_step text not null
    check (onboarding_step in ('currency', 'ranking', 'airlines', 'complete')),
  onboarding_completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists captain.login_tokens (
  token_hash text primary key check (char_length(token_hash) = 64),
  user_id uuid not null references captain.users(id) on delete cascade,
  redirect_path text not null check (redirect_path in ('/trip', '/preferences')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null
);
create index if not exists captain_login_tokens_expiry_idx
  on captain.login_tokens (expires_at) where consumed_at is null;

create table if not exists captain.web_sessions (
  token_hash text primary key check (char_length(token_hash) = 64),
  user_id uuid not null references captain.users(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null,
  last_seen_at timestamptz not null
);
create index if not exists captain_web_sessions_user_idx
  on captain.web_sessions (user_id, expires_at desc);

create table if not exists captain.api_usage_days (
  usage_date date primary key,
  response_count integer not null default 0 check (response_count >= 0),
  web_search_call_count integer not null default 0 check (web_search_call_count >= 0),
  updated_at timestamptz not null
);

alter table captain.search_specs
  drop constraint if exists search_specs_provider_check;
alter table captain.search_specs
  add constraint search_specs_provider_check
  check (provider = 'openai_web' or provider ~ '^official_[a-z0-9_]+$');

alter table captain.search_runs
  drop constraint if exists search_runs_status_check;
alter table captain.search_runs
  add constraint search_runs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'deferred'));

alter table captain.offers
  drop constraint if exists offers_provider_check;
alter table captain.offers
  add constraint offers_provider_check
  check (provider = 'openai_web' or provider ~ '^official_[a-z0-9_]+$');
alter table captain.offers
  add column if not exists fare_basis text not null default 'one_adult_total',
  add column if not exists primary_airline_code text not null default 'UNK',
  add column if not exists participating_airline_codes jsonb not null default '[]'::jsonb,
  add column if not exists evidence jsonb not null default '[]'::jsonb,
  add column if not exists discovery_response_id text not null default '',
  add column if not exists verification_response_id text not null default '',
  add column if not exists prompt_version text not null default '',
  add column if not exists model text not null default '',
  add column if not exists verified_at timestamptz not null default now();

alter table captain.trip_recommendations
  add column if not exists ranking_mode text not null default 'balanced',
  add column if not exists snapshot jsonb not null default '{}'::jsonb;
alter table captain.trip_recommendations
  drop constraint if exists captain_trip_recommendations_ranking_mode_check;
alter table captain.trip_recommendations
  add constraint captain_trip_recommendations_ranking_mode_check
  check (ranking_mode in ('cheapest', 'balanced', 'fastest'));

alter table captain.notifications
  add column if not exists telegram_message_id bigint;
create unique index if not exists captain_notifications_telegram_message_idx
  on captain.notifications (user_id, telegram_message_id)
  where telegram_message_id is not null;

alter table captain.search_runs
  drop constraint if exists captain_search_runs_retained_offer_count_check;
alter table captain.search_runs
  add constraint captain_search_runs_retained_offer_count_check
  check (retained_offer_count is null or retained_offer_count between 0 and 20);

create or replace function captain.enforce_offer_storage_limit()
returns trigger
language plpgsql
as $$
begin
  delete from captain.offers offer
  where offer.search_spec_id = new.search_spec_id
    and offer.search_run_id <> new.search_run_id;

  delete from captain.offers offer
  where offer.id in (
    select candidate.id
    from captain.offers candidate
    where candidate.search_run_id = new.search_run_id
    order by candidate.price, candidate.observed_at desc, candidate.id
    offset 20
  );
  return null;
end
$$;

drop schema if exists flight_agent cascade;
