-- Plan confirmation is an event, regardless of whether it came from Telegram
-- text, a Telegram button, or the web UI. Its progress message therefore uses
-- the notification outbox instead of being posted by any one channel handler.
alter table captain.notifications drop constraint if exists notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'tracking_started', 'initial_results', 'price_drop', 'new_best',
  'watch_attention', 'inventory_gap', 'price_rise', 'tracking_activation',
  'tracking_summary'
));
