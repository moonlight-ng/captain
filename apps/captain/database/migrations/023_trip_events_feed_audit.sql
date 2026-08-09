-- trip_events is the trip-scoped agent feed/audit log. Extend it so Telegram
-- deliveries and trip-scoped assistant replies can carry the spoken body and
-- link back to notifications / chat messages.
alter table captain.trip_events
  add column if not exists body text
    check (body is null or char_length(body) between 1 and 20000);

alter table captain.trip_events
  add column if not exists channel text not null default 'system'
    check (channel in ('system', 'telegram', 'web'));

alter table captain.trip_events
  add column if not exists notification_id uuid
    references captain.notifications(id) on delete set null;

create index if not exists captain_trip_events_notification_idx
  on captain.trip_events (notification_id)
  where notification_id is not null;
