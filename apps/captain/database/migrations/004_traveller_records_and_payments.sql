-- Traveller identity records, trip assignment, and tokenized payment methods.
-- Order placement is out of scope; this migration only stores the data model.

create table captain.passengers (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  given_name text not null,
  family_name text not null,
  title text check (title is null or title in ('mr', 'ms', 'mrs', 'miss', 'dr')),
  gender text check (gender is null or gender in ('m', 'f')),
  born_on date,
  email text,
  phone_number text,
  is_default boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index captain_passengers_one_default_idx
  on captain.passengers (user_id) where is_default;

create index captain_passengers_user_idx on captain.passengers (user_id);

create function captain.enforce_passenger_limit()
returns trigger
language plpgsql
as $$
declare
  passenger_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(new.user_id::text || ':passengers'));
  select count(*) into passenger_count
  from captain.passengers passenger
  where passenger.user_id = new.user_id
    and passenger.id <> new.id;

  if passenger_count >= 8 then
    raise exception 'A traveller may have at most 8 passenger records'
      using errcode = 'check_violation',
        constraint = 'captain_passengers_max_eight';
  end if;
  return new;
end
$$;

create trigger captain_passengers_enforce_limit
before insert on captain.passengers
for each row execute function captain.enforce_passenger_limit();

create table captain.trip_passengers (
  trip_id uuid not null references captain.trips(id) on delete cascade,
  passenger_id uuid not null references captain.passengers(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  primary key (trip_id, passenger_id),
  unique (trip_id, ordinal)
);

create index captain_trip_passengers_passenger_idx
  on captain.trip_passengers (passenger_id);

create table captain.payment_methods (
  id uuid primary key,
  user_id uuid not null references captain.users(id) on delete cascade,
  provider text not null check (provider = 'duffel'),
  provider_card_id text not null,
  brand text not null,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  expiry_month integer not null check (expiry_month between 1 and 12),
  expiry_year integer not null check (expiry_year >= 2000),
  cardholder_name text not null,
  status text not null check (status in ('active', 'removed')),
  is_default boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id, provider_card_id)
);

comment on table captain.payment_methods is
  'Tokenized payment instruments only. No PAN and no CVC is ever stored.';

create unique index captain_payment_methods_one_default_idx
  on captain.payment_methods (user_id) where is_default and status = 'active';

create index captain_payment_methods_user_idx
  on captain.payment_methods (user_id) where status = 'active';

alter table captain.traveller_profiles
  add column traveller_setup_prompted_at timestamptz;

alter table captain.login_tokens
  drop constraint if exists login_tokens_redirect_path_check;

alter table captain.login_tokens
  add constraint login_tokens_redirect_path_check
  check (redirect_path in ('/trip', '/preferences', '/payment', '/travellers'));

-- Trap A: new tables get RLS + policies + grants inline. roles.sql's policy
-- loop cannot be safely re-run after a new migration. Fresh databases (CI)
-- may not have run roles.sql yet, so ensure the group roles exist first.
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
  foreach table_name in array array['passengers', 'trip_passengers', 'payment_methods']
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

alter function captain.enforce_passenger_limit() owner to captain_migrator;
