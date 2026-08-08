-- A Trip is an ordered sequence of cities connected by independently
-- searchable flight legs. The legacy brief remains intact for compatibility.
create table captain.trip_cities (
  id uuid primary key,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  position integer not null check (position between 0 and 6),
  label text not null check (char_length(label) between 1 and 120),
  airport_codes jsonb not null check (
    jsonb_typeof(airport_codes) = 'array'
    and jsonb_array_length(airport_codes) between 1 and 6
  ),
  arrival_start date,
  arrival_end date,
  departure_start date,
  departure_end date,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (trip_id, position),
  check ((arrival_start is null) = (arrival_end is null)),
  check (arrival_end is null or arrival_end >= arrival_start),
  check ((departure_start is null) = (departure_end is null)),
  check (departure_end is null or departure_end >= departure_start)
);

create index captain_trip_cities_trip_idx
  on captain.trip_cities (trip_id, position);

create table captain.trip_legs (
  id uuid primary key,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  position integer not null check (position between 0 and 5),
  origin_city_id uuid not null references captain.trip_cities(id) on delete cascade,
  destination_city_id uuid not null references captain.trip_cities(id) on delete cascade,
  departure_start date not null,
  departure_end date not null,
  arrive_by date,
  selected_flight_key text,
  latest_search_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (trip_id, position),
  check (origin_city_id <> destination_city_id),
  check (departure_end >= departure_start),
  check (arrive_by is null or arrive_by >= departure_start)
);

create index captain_trip_legs_trip_idx
  on captain.trip_legs (trip_id, position);

create table captain.leg_search_snapshots (
  id uuid primary key,
  trip_id uuid not null references captain.trips(id) on delete cascade,
  leg_id uuid not null references captain.trip_legs(id) on delete cascade,
  revision integer not null check (revision > 0),
  status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed')),
  requested_start date not null,
  requested_end date not null,
  analysis jsonb not null,
  flights jsonb not null default '[]'::jsonb check (jsonb_typeof(flights) = 'array'),
  offers jsonb not null default '[]'::jsonb check (jsonb_typeof(offers) = 'array'),
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (requested_end >= requested_start)
);

create index captain_leg_search_snapshots_leg_created_idx
  on captain.leg_search_snapshots (leg_id, created_at desc);

alter table captain.trip_legs
  add constraint captain_trip_legs_latest_search_id_fkey
  foreign key (latest_search_id) references captain.leg_search_snapshots(id) on delete set null;

-- Normalize every legacy brief. Context remains only in the compatibility
-- brief and is not copied into the new city/leg model.
with route_legs as (
  select
    trip.id as trip_id,
    (item.ordinality - 1)::integer as position,
    item.leg -> 'originAirports' as origin_airports,
    item.leg -> 'destinationAirports' as destination_airports,
    (item.leg #>> '{departureWindow,start}')::date as departure_start,
    (item.leg #>> '{departureWindow,end}')::date as departure_end,
    trip.created_at,
    trip.updated_at
  from captain.trips trip
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(trip.brief -> 'legs') = 'array'
      then trip.brief -> 'legs' else '[]'::jsonb end
  )
    with ordinality as item(leg, ordinality)
  where trip.brief ->> 'tripType' = 'multi_city'
    and jsonb_typeof(trip.brief -> 'legs') = 'array'

  union all

  select
    trip.id,
    0,
    trip.brief -> 'originAirports',
    trip.brief -> 'destinationAirports',
    (trip.brief #>> '{departureWindow,start}')::date,
    (trip.brief #>> '{departureWindow,end}')::date,
    trip.created_at,
    trip.updated_at
  from captain.trips trip
  where trip.brief ->> 'tripType' in ('one_way', 'round_trip')

  union all

  select
    trip.id,
    1,
    trip.brief -> 'destinationAirports',
    trip.brief -> 'originAirports',
    (trip.brief #>> '{departureWindow,start}')::date
      + coalesce((trip.brief #>> '{stayNights,minimum}')::integer, 0),
    (trip.brief #>> '{departureWindow,end}')::date
      + coalesce((trip.brief #>> '{stayNights,maximum}')::integer, 0),
    trip.created_at,
    trip.updated_at
  from captain.trips trip
  where trip.brief ->> 'tripType' = 'round_trip'
), city_points as (
  select
    leg.trip_id,
    leg.position,
    leg.origin_airports as airport_codes,
    lag(leg.departure_start) over (partition by leg.trip_id order by leg.position) as arrival_start,
    lag(leg.departure_end) over (partition by leg.trip_id order by leg.position) as arrival_end,
    leg.departure_start,
    leg.departure_end,
    leg.created_at,
    leg.updated_at
  from route_legs leg

  union all

  select
    leg.trip_id,
    leg.position + 1,
    leg.destination_airports,
    leg.departure_start,
    leg.departure_end,
    null,
    null,
    leg.created_at,
    leg.updated_at
  from route_legs leg
  where leg.position = (
    select max(last_leg.position) from route_legs last_leg where last_leg.trip_id = leg.trip_id
  )
)
insert into captain.trip_cities (
  id, trip_id, position, label, airport_codes,
  arrival_start, arrival_end, departure_start, departure_end,
  created_at, updated_at
)
select
  gen_random_uuid(),
  point.trip_id,
  point.position,
  coalesce(
    case point.airport_codes ->> 0
      when 'LOS' then 'Lagos'
      when 'ABV' then 'Abuja'
      when 'ACC' then 'Accra'
      when 'NBO' then 'Nairobi'
      when 'EBB' then 'Entebbe'
      when 'KGL' then 'Kigali'
      when 'ADD' then 'Addis Ababa'
      when 'JNB' then 'Johannesburg'
      when 'CPT' then 'Cape Town'
      when 'LON' then 'London'
      when 'LHR' then 'London'
      when 'LGW' then 'London'
      when 'LCY' then 'London'
      when 'STN' then 'London'
      when 'NYC' then 'New York'
      when 'JFK' then 'New York'
      when 'EWR' then 'New York'
      when 'LGA' then 'New York'
      when 'PAR' then 'Paris'
      when 'CDG' then 'Paris'
      when 'ORY' then 'Paris'
      else null
    end,
    (select string_agg(code, '/' order by ordinal)
      from jsonb_array_elements_text(point.airport_codes)
        with ordinality as airport(code, ordinal))
  ),
  point.airport_codes,
  point.arrival_start,
  point.arrival_end,
  point.departure_start,
  point.departure_end,
  point.created_at,
  point.updated_at
from city_points point
where not exists (
  select 1 from captain.trip_cities existing where existing.trip_id = point.trip_id
);

with route_legs as (
  select
    trip.id as trip_id,
    (item.ordinality - 1)::integer as position,
    (item.leg #>> '{departureWindow,start}')::date as departure_start,
    (item.leg #>> '{departureWindow,end}')::date as departure_end,
    trip.created_at,
    trip.updated_at
  from captain.trips trip
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(trip.brief -> 'legs') = 'array'
      then trip.brief -> 'legs' else '[]'::jsonb end
  )
    with ordinality as item(leg, ordinality)
  where trip.brief ->> 'tripType' = 'multi_city'
    and jsonb_typeof(trip.brief -> 'legs') = 'array'

  union all

  select trip.id, 0,
    (trip.brief #>> '{departureWindow,start}')::date,
    (trip.brief #>> '{departureWindow,end}')::date,
    trip.created_at, trip.updated_at
  from captain.trips trip
  where trip.brief ->> 'tripType' in ('one_way', 'round_trip')

  union all

  select trip.id, 1,
    (trip.brief #>> '{departureWindow,start}')::date
      + coalesce((trip.brief #>> '{stayNights,minimum}')::integer, 0),
    (trip.brief #>> '{departureWindow,end}')::date
      + coalesce((trip.brief #>> '{stayNights,maximum}')::integer, 0),
    trip.created_at, trip.updated_at
  from captain.trips trip
  where trip.brief ->> 'tripType' = 'round_trip'
)
insert into captain.trip_legs (
  id, trip_id, position, origin_city_id, destination_city_id,
  departure_start, departure_end, arrive_by,
  selected_flight_key, latest_search_id, created_at, updated_at
)
select
  gen_random_uuid(), leg.trip_id, leg.position,
  origin.id, destination.id,
  leg.departure_start, leg.departure_end, null,
  null, null, leg.created_at, leg.updated_at
from route_legs leg
join captain.trip_cities origin
  on origin.trip_id = leg.trip_id and origin.position = leg.position
join captain.trip_cities destination
  on destination.trip_id = leg.trip_id and destination.position = leg.position + 1
where not exists (
  select 1 from captain.trip_legs existing where existing.trip_id = leg.trip_id
);

-- Manual-search trips do not participate in the legacy scheduler. Keep every
-- Watch and its historical offer mappings readable, but retire pending work.
update captain.watches
set
  status = 'completed',
  next_check_at = null,
  completed_at = coalesce(completed_at, now()),
  updated_at = now()
where status <> 'completed' or next_check_at is not null;

-- These statuses described the retired automatic tracker. The trip and all
-- retained search history remain readable, but the traveller must explicitly
-- search a leg to obtain a new snapshot.
update captain.trips
set status = 'draft', version = version + 1, updated_at = now()
where status in ('tracking', 'recommended', 'paused');
