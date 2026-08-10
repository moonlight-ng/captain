-- captain.conversations.summary has existed since the baseline but was never
-- written: it defaulted to '' and was only ever reset to ''. The agent's
-- injected context has therefore always read "No summary yet.", so a
-- conversation older than the messages still in context was simply forgotten.
--
-- These columns make summarising resumable. summary_through_message_id marks
-- how far the last summary consumed, so a turn can tell how much is new and
-- summarise only that; summary_updated_at is for observability and for
-- deciding a summary is stale enough to redo.

alter table captain.conversations
  add column if not exists summary_updated_at timestamptz,
  add column if not exists summary_through_message_id uuid;

-- Deliberately not a foreign key to captain.messages: a summary stays valid
-- after the message that closed it is pruned, and losing the marker would
-- silently re-summarise the whole history.
comment on column captain.conversations.summary_through_message_id is
  'Last message included in summary. Not an FK: outlives message retention.';
