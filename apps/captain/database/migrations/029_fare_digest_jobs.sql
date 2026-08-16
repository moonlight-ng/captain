-- A fare digest is an opt-in recurring market question. It is deliberately
-- separate from the default price-change watch: the traveller receives one
-- useful summary every local day even when the cheapest fare did not move.
alter table captain.watches
  add column purpose text not null default 'price_changes',
  add column digest_hour_local integer,
  add column digest_time_zone text,
  add column digest_intro text;

alter table captain.watches
  add constraint captain_watches_purpose_check
    check (purpose in ('price_changes', 'fare_digest')),
  add constraint captain_watches_digest_hour_check
    check (digest_hour_local is null or digest_hour_local between 0 and 23),
  add constraint captain_watches_digest_config_check
    check (
      (purpose = 'price_changes'
        and digest_hour_local is null
        and digest_time_zone is null
        and digest_intro is null)
      or
      (purpose = 'fare_digest'
        and digest_hour_local is not null
        and digest_time_zone is not null
        and digest_intro is not null)
    );

alter table captain.notifications drop constraint if exists notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'tracking_started', 'initial_results', 'price_drop', 'new_best',
  'watch_attention', 'inventory_gap', 'price_rise', 'tracking_activation',
  'tracking_summary', 'fare_digest', 'plan_changed', 'tracking_paused',
  'tracking_resumed', 'trip_closed'
));

comment on column captain.watches.purpose is
  'price_changes follows material changes; fare_digest answers a recurring market question daily.';
