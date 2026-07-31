-- Keep recommendations durable while the underlying provider offers remain
-- deliberately short-lived.
alter table captain.trip_recommendations
  drop constraint if exists trip_recommendations_offer_id_fkey;

alter table captain.trip_recommendations
  alter column offer_id drop not null;

alter table captain.trip_recommendations
  add constraint trip_recommendations_offer_id_fkey
  foreign key (offer_id) references captain.offers(id) on delete set null;

alter table captain.trip_recommendations
  add column if not exists search_spec_id text;

update captain.trip_recommendations recommendation
set search_spec_id = offer.search_spec_id
from captain.offers offer
where offer.id = recommendation.offer_id
  and recommendation.search_spec_id is null;

alter table captain.trip_recommendations
  drop constraint if exists trip_recommendations_search_spec_id_fkey;

alter table captain.trip_recommendations
  add constraint trip_recommendations_search_spec_id_fkey
  foreign key (search_spec_id) references captain.search_specs(id) on delete set null;

create index if not exists captain_trip_recommendations_search_spec_idx
  on captain.trip_recommendations (search_spec_id)
  where search_spec_id is not null;

-- Price history is independent of the short-lived search-run and SearchSpec
-- records. Retaining their identifiers when available is useful, but deleting
-- those records must not erase compact historical price points.
alter table captain.price_observations
  drop constraint if exists price_observations_search_run_id_fkey;

alter table captain.price_observations
  add constraint price_observations_search_run_id_fkey
  foreign key (search_run_id) references captain.search_runs(id) on delete set null;

alter table captain.price_observations
  drop constraint if exists price_observations_search_spec_id_fkey;

alter table captain.price_observations
  add constraint price_observations_search_spec_id_fkey
  foreign key (search_spec_id) references captain.search_specs(id) on delete set null;

alter table captain.search_runs
  add column if not exists provider_offer_count integer,
  add column if not exists retained_offer_count integer;

alter table captain.search_runs
  drop constraint if exists captain_search_runs_provider_offer_count_check;

alter table captain.search_runs
  add constraint captain_search_runs_provider_offer_count_check
  check (provider_offer_count is null or provider_offer_count >= 0);

alter table captain.search_runs
  drop constraint if exists captain_search_runs_retained_offer_count_check;

alter table captain.search_runs
  add constraint captain_search_runs_retained_offer_count_check
  check (
    retained_offer_count is null
    or retained_offer_count between 0 and 25
  );

create index if not exists captain_offers_spec_price_idx
  on captain.offers (search_spec_id, price, observed_at desc);

create index if not exists captain_price_observations_observed_idx
  on captain.price_observations (observed_at);

create index if not exists captain_search_runs_completed_idx
  on captain.search_runs (completed_at)
  where status in ('completed', 'failed');

-- This trigger is a compatibility guard for an older worker that still sends
-- the complete Duffel payload. Only bounded, presentation-ready fields reach
-- disk; the large `raw` object is always discarded.
create or replace function captain.compact_offer_snapshot()
returns trigger
language plpgsql
as $$
begin
  new.snapshot = jsonb_strip_nulls(jsonb_build_object(
    'route', left(coalesce(new.snapshot ->> 'route', ''), 300),
    'airlineCodes', coalesce(new.snapshot -> 'airlineCodes', '[]'::jsonb),
    'flightNumbers', coalesce(new.snapshot -> 'flightNumbers', '[]'::jsonb),
    'stops', coalesce(new.snapshot -> 'stops', '0'::jsonb),
    'durationSeconds', coalesce(new.snapshot -> 'durationSeconds', '0'::jsonb),
    'conditions', coalesce(new.snapshot -> 'conditions', '{}'::jsonb),
    'segments', coalesce(new.snapshot -> 'segments', '[]'::jsonb)
  ));
  return new;
end
$$;

drop trigger if exists captain_offers_compact_snapshot on captain.offers;

create trigger captain_offers_compact_snapshot
before insert or update of snapshot on captain.offers
for each row execute function captain.compact_offer_snapshot();

-- Price history is a compact time series. Its structured columns already hold
-- every value needed for fare movement detection.
create or replace function captain.compact_price_observation()
returns trigger
language plpgsql
as $$
begin
  new.snapshot = '{}'::jsonb;
  return new;
end
$$;

drop trigger if exists captain_price_observations_compact on captain.price_observations;

create trigger captain_price_observations_compact
before insert or update of snapshot on captain.price_observations
for each row execute function captain.compact_price_observation();

-- A database-level ceiling protects the Free Plan even during a rolling
-- deployment where an older worker may still submit every provider result.
create or replace function captain.enforce_offer_storage_limit()
returns trigger
language plpgsql
as $$
begin
  delete from captain.offers offer
  where offer.search_spec_id = new.search_spec_id
    and offer.search_run_id <> new.search_run_id;

  delete from captain.offers offer
  where offer.id in (
    select candidate.id
    from captain.offers candidate
    where candidate.search_run_id = new.search_run_id
    order by candidate.price, candidate.observed_at desc, candidate.id
    offset 25
  );

  delete from captain.itineraries itinerary
  where not exists (
    select 1 from captain.offers offer
    where offer.itinerary_key = itinerary.itinerary_key
  );
  return null;
end
$$;

drop trigger if exists captain_offers_limit_storage on captain.offers;

create trigger captain_offers_limit_storage
after insert on captain.offers
for each row execute function captain.enforce_offer_storage_limit();

create or replace function captain.enforce_price_history_run_limit()
returns trigger
language plpgsql
as $$
begin
  if new.search_run_id is not null then
    delete from captain.price_observations observation
    where observation.id in (
      select candidate.id
      from captain.price_observations candidate
      where candidate.search_run_id = new.search_run_id
      order by candidate.price, candidate.observed_at desc, candidate.id
      offset 25
    );
  end if;
  return null;
end
$$;

drop trigger if exists captain_price_observations_limit_run on captain.price_observations;

create trigger captain_price_observations_limit_run
after insert on captain.price_observations
for each row execute function captain.enforce_price_history_run_limit();
