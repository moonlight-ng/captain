-- Replace open-ended, departure-relative watching with one fixed three-day
-- tracking run. Existing live watches receive a fresh three-day run
-- so deploying this migration never completes a traveller's trip abruptly.

alter table captain.watches
  add column tracking_duration_hours integer,
  add column run_started_at timestamptz,
  add column run_ends_at timestamptz,
  add column completed_at timestamptz,
  add column checks_completed integer;

update captain.watches
set
  cadence_hours = 6,
  tracking_duration_hours = 72,
  run_started_at = case
    when status in ('active', 'scheduled', 'paused') then now()
    else coalesce(activated_at, created_at)
  end,
  run_ends_at = case
    when status in ('active', 'scheduled', 'paused') then now() + interval '72 hours'
    else coalesce(updated_at, created_at)
  end,
  completed_at = case when status = 'completed' then updated_at else null end,
  checks_completed = case when last_check_at is null then 0 else 1 end,
  status = case when status = 'scheduled' then 'active' else status end,
  next_check_at = case when status = 'scheduled' then now() else next_check_at end,
  tracking_starts_at = null,
  baseline_completed_at = null,
  activated_at = case when status = 'scheduled' then now() else activated_at end;

alter table captain.watches
  alter column tracking_duration_hours set not null,
  alter column run_started_at set not null,
  alter column run_ends_at set not null,
  alter column checks_completed set not null,
  add constraint captain_watches_tracking_duration_check
    check (tracking_duration_hours = 72),
  add constraint captain_watches_tracking_window_check
    check (run_ends_at > run_started_at),
  add constraint captain_watches_checks_completed_check
    check (checks_completed >= 0),
  add constraint captain_watches_cadence_six_hours_check
    check (cadence_hours = 6);

create index captain_watches_run_ends_idx on captain.watches (run_ends_at)
  where status = 'active';

alter table captain.notifications drop constraint notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'initial_results', 'price_drop', 'new_best', 'watch_attention', 'inventory_gap',
  'daily_digest', 'price_rise', 'tracking_activation', 'tracking_checkin',
  'tracking_paused', 'tracking_summary'
));
