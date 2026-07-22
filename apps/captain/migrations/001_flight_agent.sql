create schema if not exists flight_agent;

create table if not exists flight_agent.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists flight_agent.agents (
  agent_key text primary key,
  status text not null check (status in ('queued', 'active', 'paused', 'needs_attention')),
  version integer not null default 1,
  brief jsonb not null,
  cadence_hours integer not null check (cadence_hours in (1, 6, 12, 24)),
  search_cursor integer not null default 0,
  browse_preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  activated_at timestamptz,
  paused_at timestamptz,
  accumulated_runtime_ms bigint not null default 0,
  last_check_at timestamptz,
  next_check_at timestamptz,
  running_check_id uuid,
  consecutive_failures integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists flight_agent_agents_due_idx
  on flight_agent.agents (next_check_at)
  where status <> 'paused' and running_check_id is null;

create table if not exists flight_agent.agent_states (
  agent_key text primary key references flight_agent.agents(agent_key) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists flight_agent.checks (
  id uuid primary key,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed')),
  trigger text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  matrix jsonb not null default '[]'::jsonb,
  searched integer not null default 0,
  offers_found integer not null default 0,
  identities_matched integer not null default 0,
  promotions integer not null default 0,
  duffel_error text
);

create index if not exists flight_agent_checks_agent_started_idx
  on flight_agent.checks (agent_key, started_at desc);

create table if not exists flight_agent.flights (
  id uuid primary key,
  destination_iata text not null,
  departure_local_date date not null,
  marketing_carrier_code text not null,
  marketing_carrier_name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (destination_iata, departure_local_date, marketing_carrier_code)
);

create table if not exists flight_agent.agent_flights (
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  flight_id uuid not null references flight_agent.flights(id),
  review_state text not null check (review_state in ('discovered', 'promoted', 'retained', 'dismissed')),
  promotion_reason text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  latest_snapshot jsonb not null,
  primary key (agent_key, flight_id)
);

create table if not exists flight_agent.price_observations (
  id uuid primary key,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  flight_id uuid not null references flight_agent.flights(id),
  check_id uuid not null references flight_agent.checks(id) on delete cascade,
  observed_at timestamptz not null,
  price numeric(12, 2) not null,
  currency text not null,
  snapshot jsonb not null,
  unique (agent_key, flight_id, check_id)
);

create index if not exists flight_agent_observations_timeline_idx
  on flight_agent.price_observations (agent_key, flight_id, observed_at);

create table if not exists flight_agent.research_runs (
  id text primary key,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  check_id uuid not null references flight_agent.checks(id) on delete cascade,
  status text not null check (status in ('completed', 'failed')),
  searched_at timestamptz not null,
  overview text,
  findings jsonb not null default '[]'::jsonb,
  gaps jsonb not null default '[]'::jsonb,
  error text
);

create table if not exists flight_agent.activities (
  id uuid primary key,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  kind text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index if not exists flight_agent_activity_idx
  on flight_agent.activities (agent_key, created_at desc);

create table if not exists flight_agent.folders (
  id uuid primary key,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null,
  unique (agent_key, name)
);

create table if not exists flight_agent.folder_memberships (
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  folder_id uuid not null references flight_agent.folders(id) on delete cascade,
  flight_id uuid not null references flight_agent.flights(id),
  primary key (folder_id, flight_id)
);

create table if not exists flight_agent.idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scope, idempotency_key)
);

create table if not exists flight_agent.source_imports (
  source_table text not null,
  source_id text not null,
  agent_key text not null references flight_agent.agents(agent_key) on delete cascade,
  target_type text not null,
  target_id text not null,
  imported_at timestamptz not null default now(),
  primary key (source_table, source_id)
);
