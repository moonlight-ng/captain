alter table captain.project_meta
  add column if not exists usage_tracking_started_at timestamptz;

update captain.project_meta
set usage_tracking_started_at = coalesce(usage_tracking_started_at, now())
where singleton = true;

alter table captain.project_meta
  alter column usage_tracking_started_at set not null;

create table captain.agent_sessions (
  session_id text primary key,
  user_id uuid references captain.users(id) on delete set null,
  agent_name text not null,
  channel text not null,
  model text not null,
  status text not null check (status in ('active', 'waiting', 'completed', 'failed')),
  started_at timestamptz not null,
  last_event_at timestamptz not null,
  last_turn_at timestamptz,
  ended_at timestamptz,
  failure_code text,
  updated_at timestamptz not null
);

create index captain_agent_sessions_user_activity_idx
  on captain.agent_sessions (user_id, last_event_at desc);
create index captain_agent_sessions_status_activity_idx
  on captain.agent_sessions (status, last_event_at desc);

create table captain.model_usage_events (
  event_key text primary key,
  user_id uuid references captain.users(id) on delete set null,
  session_id text,
  source text not null check (source in ('eve', 'gateway')),
  operation text not null,
  model text not null,
  provider text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  cost_usd numeric(20, 12) check (cost_usd is null or cost_usd >= 0),
  gateway_generation_id text,
  lookup_status text not null check (lookup_status in ('pending', 'complete', 'unavailable')),
  lookup_attempts integer not null default 0 check (lookup_attempts >= 0),
  last_lookup_at timestamptz,
  occurred_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index captain_model_usage_generation_idx
  on captain.model_usage_events (gateway_generation_id)
  where gateway_generation_id is not null;
create index captain_model_usage_occurred_idx
  on captain.model_usage_events (occurred_at desc);
create index captain_model_usage_user_occurred_idx
  on captain.model_usage_events (user_id, occurred_at desc);
create index captain_model_usage_pending_idx
  on captain.model_usage_events (lookup_attempts, occurred_at)
  where lookup_status = 'pending';

grant select, insert, update, delete on captain.agent_sessions to captain_runtime;
grant select, insert, update, delete on captain.model_usage_events to captain_runtime;
grant select on captain.project_meta to captain_runtime;
