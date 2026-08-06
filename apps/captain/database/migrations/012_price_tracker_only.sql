-- Captain tracks fares. It does not sell them, and it never did: booking was
-- always a labelled prototype against a fixed display-only test card. This
-- removes the schema that existed to support a purchase that cannot happen.
--
-- This is destructive and deliberately so. Passenger records held names, dates
-- of birth, contact details and encrypted passport numbers that Captain has no
-- remaining use for; keeping them would mean holding identity documents for a
-- product that only watches prices. Payment rows held Duffel card tokens.
--
-- Any card token still queued for remote deletion is dropped here without being
-- sent to Duffel. Confirm the deletion queue has drained before applying this:
--   select status, count(*) from captain.payment_card_deletions group by status;

drop trigger if exists captain_payment_methods_enforce_limit on captain.payment_methods;
drop function if exists captain.enforce_payment_method_limit();
drop trigger if exists captain_passengers_enforce_limit on captain.passengers;
drop function if exists captain.enforce_passenger_limit();

drop table if exists captain.payment_card_deletions;
drop table if exists captain.payment_card_setup_intents;
drop table if exists captain.payment_methods;
drop table if exists captain.trip_passengers;
drop table if exists captain.passengers;

-- pgcrypto stays installed. Passport ciphertext was the only thing Captain
-- used it for, but `drop extension` errors rather than warns when anything
-- still depends on it, and a migration that can fail the release command is a
-- bad trade for removing an unused extension.

alter table captain.traveller_profiles
  drop column if exists tracking_checkins_enabled,
  drop column if exists traveller_setup_prompted_at;

-- Tracking now runs once a day until the trip departs, so a watch no longer
-- carries a cadence or a duration: the cadence is fixed and the duration is
-- the departure date. Existing live runs are extended to that date rather than
-- being cut short at whatever remained of their three days.
alter table captain.watches
  drop constraint if exists captain_watches_cadence_six_hours_check,
  drop constraint if exists captain_watches_tracking_duration_check;

update captain.watches watch
set run_ends_at = least(
      now() + interval '400 days',
      greatest(
        ((trip.brief #>> '{departureWindow,start}') || 'T23:59:59.999Z')::timestamptz,
        now() + interval '1 day'
      )
    ),
    next_check_at = case
      when watch.status = 'active' then least(watch.next_check_at, now() + interval '1 day')
      else watch.next_check_at
    end,
    updated_at = now()
from captain.trips trip
where trip.id = watch.trip_id
  and watch.status in ('active', 'scheduled')
  and trip.status not in ('cancelled', 'completed', 'archived')
  and (trip.brief #>> '{departureWindow,start}') ~ '^\d{4}-\d{2}-\d{2}$';

alter table captain.watches
  drop column if exists cadence_hours,
  drop column if exists tracking_duration_hours,
  drop column if exists check_in_sent_at,
  drop column if exists auto_pause_at;

-- The check-in asked whether a quiet traveller still wanted the trip, then
-- paused it. A trip booked months ahead is quiet by nature, so both are gone.
-- Every row of these kinds goes, not just the pending ones: the tightened
-- constraint below is checked against delivered rows too, so a single sent
-- check-in left behind would fail the migration.
delete from captain.notifications where kind in ('tracking_checkin', 'tracking_paused');

alter table captain.notifications drop constraint if exists notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'initial_results', 'price_drop', 'new_best', 'watch_attention', 'inventory_gap',
  'daily_digest', 'price_rise', 'tracking_activation', 'tracking_summary'
));

comment on table captain.price_observations is
  'Every price Captain has seen for an itinerary. The watched flight''s series is what the dashboard charts.';
