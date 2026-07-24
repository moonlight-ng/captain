-- Run retention from the database as well as the worker. This keeps the bound
-- in force during rolling deployments and if an older worker is restarted.
create or replace function captain.maintain_watch_retention()
returns trigger
language plpgsql
as $$
begin
  delete from captain.price_observations
  where observed_at < now() - interval '90 days';

  delete from captain.offers
  where observed_at < now() - interval '7 days'
     or (expires_at is not null and expires_at <= now());

  delete from captain.search_runs
  where id <> new.id
    and status in ('completed', 'failed')
    and completed_at < now() - interval '7 days';

  delete from captain.itineraries itinerary
  where not exists (
    select 1 from captain.offers offer
    where offer.itinerary_key = itinerary.itinerary_key
  );

  return null;
end
$$;

drop trigger if exists captain_search_runs_maintain_retention on captain.search_runs;

create trigger captain_search_runs_maintain_retention
after insert on captain.search_runs
for each row execute function captain.maintain_watch_retention();
