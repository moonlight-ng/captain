-- Captain used to send a scheduled digest whether or not anything had
-- happened, so a traveller's first message about a brand-new trip could be
-- "no meaningful change" — a notification whose entire content was that there
-- was nothing to notify about. The digest is gone, along with the cadence
-- settings that only existed to schedule it.
--
-- What remains is the rule the product always wanted: Captain speaks when the
-- price range moves or the watched flight moves, and otherwise stays quiet.
-- 'smart' and 'daily' collapse into 'changes_only'; 'off' still means silence.

-- Queued digests would arrive after the constraint below forbids their kind,
-- and a delivered one still fails the check, so both go.
delete from captain.notifications where kind = 'daily_digest';

alter table captain.notifications drop constraint if exists notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'initial_results', 'price_drop', 'new_best', 'watch_attention', 'inventory_gap',
  'price_rise', 'tracking_activation', 'tracking_summary'
));

-- A change held back for the next digest has no digest to wait for. Dropping
-- the key rather than nulling it matches what the stores now read back.
update captain.trip_recommendations
set snapshot = snapshot - 'pendingDigestChange',
  updated_at = now()
where snapshot ? 'pendingDigestChange';

update captain.traveller_profiles
set notification_mode = 'changes_only',
  updated_at = now()
where notification_mode in ('smart', 'daily');

alter table captain.traveller_profiles
  drop constraint if exists captain_profiles_notification_mode_check;
alter table captain.traveller_profiles
  drop constraint if exists traveller_profiles_notification_mode_check;
alter table captain.traveller_profiles
  add constraint traveller_profiles_notification_mode_check
  check (notification_mode in ('changes_only', 'off'));

alter table captain.traveller_profiles
  alter column notification_mode set default 'changes_only';

alter table captain.traveller_profiles
  drop column if exists digest_hour_local,
  drop column if exists last_digest_at;

comment on column captain.traveller_profiles.notification_mode is
  'changes_only: speak when the price range or the watched fare moves. off: never speak.';
