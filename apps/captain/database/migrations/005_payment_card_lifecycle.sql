-- Harden payment card lifecycle: one active card, setup intents, leased deletion queue.
-- Removes fabricated expiry columns and backfills remote-deletion work for retired cards.

-- Drop fabricated expiry. Duffel Components does not expose authoritative expiry to the server.
alter table captain.payment_methods
  drop column expiry_month,
  drop column expiry_year;

-- Replace the one-default index; one-active is created only after backfill retires duplicates.
drop index if exists captain.captain_payment_methods_one_default_idx;

-- Deletion queue first so the backfill can enqueue retired cards. Survives user cascade (no user FK).
create table captain.payment_card_deletions (
  id uuid primary key,
  provider text not null check (provider = 'duffel'),
  provider_card_id text not null,
  payment_method_id uuid,
  status text not null check (status in ('queued', 'running')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null,
  claimed_by text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_detail text check (last_error_detail is null or char_length(last_error_detail) <= 500),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_card_id)
);

create index captain_payment_card_deletions_claim_idx
  on captain.payment_card_deletions (status, available_at, lease_expires_at);

comment on table captain.payment_card_deletions is
  'Leased remote card deletion queue. Provider tokens are retained until Duffel confirms deletion.';

-- Backfill BEFORE the one-active unique index: version 004 left prior cards active after replace.
-- Keep the current default active card; retire every other active card and enqueue deletion.
-- Also enqueue already-removed cards that still retain a provider token.
do $$
declare
  row record;
  default_id uuid;
begin
  for row in
    select distinct user_id from captain.payment_methods
  loop
    select id into default_id
    from captain.payment_methods
    where user_id = row.user_id
      and status = 'active'
      and is_default
    order by updated_at desc
    limit 1;

    if default_id is null then
      select id into default_id
      from captain.payment_methods
      where user_id = row.user_id
        and status = 'active'
      order by created_at asc
      limit 1;
    end if;

    if default_id is not null then
      update captain.payment_methods
      set is_default = false,
          status = 'removed',
          updated_at = now()
      where user_id = row.user_id
        and status = 'active'
        and id <> default_id;

      update captain.payment_methods
      set is_default = true,
          updated_at = now()
      where id = default_id
        and status = 'active';
    end if;
  end loop;

  insert into captain.payment_card_deletions (
    id, provider, provider_card_id, payment_method_id, status, attempts,
    available_at, claimed_by, lease_expires_at, last_error_code, last_error_detail,
    created_at, updated_at
  )
  select
    gen_random_uuid(),
    method.provider,
    method.provider_card_id,
    method.id,
    'queued',
    0,
    now(),
    null,
    null,
    null,
    null,
    now(),
    now()
  from captain.payment_methods method
  where method.status = 'removed'
  on conflict (provider, provider_card_id) do nothing;
end
$$;

-- Safe now that each user has at most one active card.
create unique index captain_payment_methods_one_active_idx
  on captain.payment_methods (user_id) where status = 'active';

-- Cap local payment rows so removed-but-pending-deletion cards cannot grow without bound.
create function captain.enforce_payment_method_limit()
returns trigger
language plpgsql
as $$
declare
  method_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(new.user_id::text || ':payment_methods'));
  select count(*) into method_count
  from captain.payment_methods method
  where method.user_id = new.user_id
    and method.id <> new.id;

  if method_count >= 20 then
    raise exception 'A traveller may have at most 20 payment method records'
      using errcode = 'check_violation',
        constraint = 'captain_payment_methods_max_twenty';
  end if;
  return new;
end
$$;

create trigger captain_payment_methods_enforce_limit
before insert on captain.payment_methods
for each row execute function captain.enforce_payment_method_limit();

-- Setup intents: one pending reservation per user; 30-minute expiry; 24h completed retention.
create table captain.payment_card_setup_intents (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  status text not null check (status in ('pending', 'completed', 'expired')),
  payment_method_id uuid references captain.payment_methods(id) on delete set null,
  component_client_key text,
  client_key_issue_token uuid,
  client_key_issue_expires_at timestamptz,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint captain_payment_card_setup_intents_issue_lease_pair check (
    (client_key_issue_token is null) = (client_key_issue_expires_at is null)
  ),
  constraint captain_payment_card_setup_intents_issue_lease_without_key check (
    component_client_key is null or client_key_issue_token is null
  ),
  constraint captain_payment_card_setup_intents_issue_lease_pending check (
    client_key_issue_token is null or status = 'pending'
  )
);

create unique index captain_payment_card_setup_intents_one_pending_idx
  on captain.payment_card_setup_intents (user_id) where status = 'pending';

create index captain_payment_card_setup_intents_user_idx
  on captain.payment_card_setup_intents (user_id);

create index captain_payment_card_setup_intents_cleanup_idx
  on captain.payment_card_setup_intents (status, expires_at, completed_at);

comment on table captain.payment_card_setup_intents is
  'Single-use card setup reservations with leased client-key issuance. Bind Duffel browser callbacks to one pending intent per user.';

-- Trap A: new tables get RLS + policies + grants inline.
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
grant all privileges on all tables in schema captain to captain_migrator;
grant all privileges on all sequences in schema captain to captain_migrator;
grant execute on all functions in schema captain to captain_migrator;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['payment_card_setup_intents', 'payment_card_deletions']
  loop
    execute format('alter table captain.%I enable row level security', table_name);
    execute format(
      'create policy captain_runtime_full_access on captain.%I for all to captain_runtime using (true) with check (true)',
      table_name
    );
    execute format(
      'grant select, insert, update, delete on captain.%I to captain_runtime',
      table_name
    );
    execute format('alter table captain.%I owner to captain_migrator', table_name);
  end loop;
end
$$;

alter function captain.enforce_payment_method_limit() owner to captain_migrator;
