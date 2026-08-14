create table captain.conversation_review_deliveries (
  review_date date primary key,
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  recipients jsonb not null default '[]'::jsonb,
  status text not null check (status in ('sending', 'delivered', 'failed')),
  claimed_at timestamptz not null,
  delivered_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

grant select, insert, update, delete
  on captain.conversation_review_deliveries
  to captain_runtime;
