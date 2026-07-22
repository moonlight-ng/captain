alter table flight_agent.agents
  add column if not exists tracking_window_days integer default 30
  check (tracking_window_days in (7, 14, 30) or tracking_window_days is null);

alter table flight_agent.agent_flights
  add column if not exists tracked_until_at timestamptz;
