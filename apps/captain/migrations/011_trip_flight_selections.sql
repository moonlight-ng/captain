-- Person-selected itineraries are durable across short-lived provider offers.
-- Captain's current recommendation remains the agent-selected flight.
create table if not exists captain.trip_flight_selections (
  trip_id uuid not null references captain.trips(id) on delete cascade,
  itinerary_key text not null,
  selected_by text not null check (selected_by in ('agent', 'person')),
  selected_at timestamptz not null,
  primary key (trip_id, itinerary_key, selected_by)
);

create index if not exists captain_trip_flight_selections_trip_selected_idx
  on captain.trip_flight_selections (trip_id, selected_at desc);
