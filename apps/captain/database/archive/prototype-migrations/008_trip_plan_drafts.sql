create table if not exists captain.trip_plan_drafts (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  status text not null check (
    status in (
      'collecting',
      'awaiting_confirmation',
      'starting',
      'started',
      'cancelled',
      'expired'
    )
  ),
  revision integer not null check (revision > 0),
  conversation jsonb not null default '[]'::jsonb,
  partial jsonb not null,
  plan jsonb,
  unresolved_fields jsonb not null default '[]'::jsonb,
  inferred_fields jsonb not null default '{}'::jsonb,
  source_message_ids jsonb not null default '[]'::jsonb,
  trip_id uuid references captain.trips(id) on delete set null,
  create_idempotency_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null
);

create unique index if not exists captain_trip_plan_drafts_one_open_idx
  on captain.trip_plan_drafts (user_id)
  where status in ('collecting', 'awaiting_confirmation', 'starting');

create index if not exists captain_trip_plan_drafts_expiry_idx
  on captain.trip_plan_drafts (expires_at)
  where status in ('collecting', 'awaiting_confirmation', 'starting');

create unique index if not exists captain_trip_plan_drafts_trip_idx
  on captain.trip_plan_drafts (trip_id)
  where trip_id is not null;

create unique index if not exists captain_trip_plan_drafts_idempotency_idx
  on captain.trip_plan_drafts (create_idempotency_key)
  where create_idempotency_key is not null;
