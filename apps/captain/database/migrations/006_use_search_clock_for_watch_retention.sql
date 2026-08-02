-- Keep retention decisions on the same clock as the search run being scheduled.
-- Runtime calls use the current time, while tests and replays may intentionally
-- supply a different logical time through search_runs.created_at.
create or replace function captain.maintain_watch_retention()
returns trigger
language plpgsql
as $$
begin
  delete from captain.price_observations
  where observed_at < new.created_at - interval '90 days';

  delete from captain.offers
  where observed_at < new.created_at - interval '7 days'
     or (expires_at is not null and expires_at <= new.created_at);

  delete from captain.search_runs
  where id <> new.id
    and status in ('completed', 'failed', 'deferred')
    and completed_at < new.created_at - interval '7 days';

  delete from captain.itineraries itinerary
  where not exists (
    select 1 from captain.offers offer
    where offer.itinerary_key = itinerary.itinerary_key
  );
  return null;
end
$$;
