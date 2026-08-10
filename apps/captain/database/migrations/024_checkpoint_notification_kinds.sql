-- Checkpoint acks: plan changes, pause/resume, and trip closed join the
-- progress notification outbox (event → Telegram → feed).
alter table captain.notifications drop constraint if exists notifications_kind_check;
alter table captain.notifications add constraint notifications_kind_check check (kind in (
  'tracking_started', 'initial_results', 'price_drop', 'new_best',
  'watch_attention', 'inventory_gap', 'price_rise', 'tracking_activation',
  'tracking_summary', 'plan_changed', 'tracking_paused', 'tracking_resumed',
  'trip_closed'
));
