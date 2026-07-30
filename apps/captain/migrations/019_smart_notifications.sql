alter table captain.traveller_profiles
  add column if not exists notification_mode text not null default 'smart',
  add column if not exists digest_hour_local integer not null default 9,
  add column if not exists price_rise_alerts_enabled boolean not null default true,
  add column if not exists better_option_alerts_enabled boolean not null default true,
  add column if not exists tracking_checkins_enabled boolean not null default true,
  add column if not exists last_digest_at timestamptz;

alter table captain.traveller_profiles
  drop constraint if exists captain_profiles_notification_mode_check;
alter table captain.traveller_profiles
  add constraint captain_profiles_notification_mode_check
  check (notification_mode in ('smart', 'daily', 'changes_only', 'off'));

alter table captain.traveller_profiles
  drop constraint if exists captain_profiles_digest_hour_check;
alter table captain.traveller_profiles
  add constraint captain_profiles_digest_hour_check
  check (digest_hour_local between 0 and 23);

update captain.traveller_profiles
set notification_mode = case when alerts_enabled then 'smart' else 'off' end,
    max_alerts_per_day = case when alerts_enabled then 1 else max_alerts_per_day end;

alter table captain.watches
  add column if not exists tracking_starts_at timestamptz,
  add column if not exists baseline_completed_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists last_user_activity_at timestamptz,
  add column if not exists check_in_sent_at timestamptz,
  add column if not exists auto_pause_at timestamptz,
  add column if not exists price_rise_itinerary_key text,
  add column if not exists price_rise_armed boolean not null default true;

update captain.watches
set last_user_activity_at = coalesce(last_user_activity_at, now());

update captain.watches watch
set tracking_starts_at =
      ((trip.brief #>> '{departureWindow,start}')::date - 30)::timestamp at time zone 'UTC',
    updated_at = now()
from captain.trips trip
where trip.id = watch.trip_id
  and trip.status not in ('cancelled', 'completed', 'archived')
  and (trip.brief #>> '{departureWindow,start}') ~ '^\d{4}-\d{2}-\d{2}$'
  and (trip.brief #>> '{departureWindow,start}')::date > current_date + 30;

update captain.watches watch
set status = 'scheduled',
    next_check_at = watch.tracking_starts_at,
    baseline_completed_at = watch.last_check_at,
    updated_at = now()
from captain.trips trip
where trip.id = watch.trip_id
  and watch.status = 'active'
  and watch.tracking_starts_at > now()
  and watch.last_check_at is not null
  and trip.status not in ('cancelled', 'completed', 'archived');

alter table captain.watches
  alter column last_user_activity_at set not null;

alter table captain.watches
  drop constraint if exists watches_status_check;
alter table captain.watches
  add constraint watches_status_check
  check (status in ('active', 'scheduled', 'paused', 'completed'));

drop index if exists captain.captain_watches_due_idx;
create index captain_watches_due_idx on captain.watches (next_check_at)
  where status in ('active', 'scheduled') and next_check_at is not null;

alter table captain.notifications
  drop constraint if exists notifications_status_check;
alter table captain.notifications
  add constraint notifications_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'superseded'));

alter table captain.notifications
  drop constraint if exists notifications_kind_check;
alter table captain.notifications
  add constraint notifications_kind_check
  check (kind in (
    'initial_results',
    'price_drop',
    'new_best',
    'watch_attention',
    'inventory_gap',
    'daily_digest',
    'price_rise',
    'tracking_activation',
    'tracking_checkin',
    'tracking_paused'
  ));

update captain.notifications
set status = 'superseded',
    error = 'Suppressed by smart notification policy',
    updated_at = now()
where status in ('pending', 'sending')
  and kind in ('inventory_gap', 'watch_attention');
