alter table flight_agent.agents
  add column if not exists processing_started_at timestamptz,
  add column if not exists accumulated_processing_ms bigint not null default 0;

alter table flight_agent.agents
  drop column if exists activated_at,
  drop column if exists paused_at,
  drop column if exists accumulated_runtime_ms;
