drop index if exists captain.captain_trips_one_active_per_user_idx;

create or replace function captain.enforce_active_trip_limit()
returns trigger
language plpgsql
as $$
declare
  active_trip_count integer;
begin
  if new.status in ('cancelled', 'completed', 'archived') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.user_id::text));

  select count(*) into active_trip_count
  from captain.trips trip
  where trip.user_id = new.user_id
    and trip.id <> new.id
    and trip.status not in ('cancelled', 'completed', 'archived');

  if active_trip_count >= 3 then
    raise exception 'A traveller may have at most 3 active Trips'
      using errcode = 'check_violation',
        constraint = 'captain_trips_max_three_active';
  end if;

  return new;
end;
$$;

drop trigger if exists captain_trips_enforce_active_limit on captain.trips;
create trigger captain_trips_enforce_active_limit
before insert or update of user_id, status
on captain.trips
for each row execute function captain.enforce_active_trip_limit();
