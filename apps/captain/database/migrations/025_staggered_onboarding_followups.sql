-- New travellers get a bounded, deterministic orientation sequence. Each
-- stage is independently durable so a delivery retry cannot repeat an earlier
-- Telegram message. Existing travellers are deliberately not backfilled.

create table captain.onboarding_followups (
  user_id uuid not null references captain.users(id) on delete cascade,
  stage text not null check (stage in ('capabilities', 'workspace', 'commands')),
  position smallint not null check (position between 1 and 3),
  sequence_started_at timestamptz not null,
  available_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts smallint not null default 0 check (attempts between 0 and 3),
  lease_expires_at timestamptz,
  telegram_message_id bigint,
  delivered_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or disabled_reason in (
    'telegram_message', 'telegram_command', 'telegram_callback',
    'workspace_opened', 'trip_activity'
  )),
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (user_id, stage),
  unique (user_id, position)
);

create index captain_onboarding_followups_due_idx
  on captain.onboarding_followups (available_at, position)
  where status = 'pending';

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
alter table captain.onboarding_followups enable row level security;
create policy captain_runtime_full_access on captain.onboarding_followups
  for all to captain_runtime using (true) with check (true);
grant select, insert, update, delete on captain.onboarding_followups to captain_runtime;
alter table captain.onboarding_followups owner to captain_migrator;
