alter table flight_agent.checks
  add column if not exists mode text not null default 'fare'
  check (mode in ('fare', 'fare_and_research'));

alter table flight_agent.research_runs
  add column if not exists model text,
  add column if not exists input_tokens bigint,
  add column if not exists cached_input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists reasoning_output_tokens bigint,
  add column if not exists duration_ms bigint;

