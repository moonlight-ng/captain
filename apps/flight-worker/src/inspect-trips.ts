import postgres from "../../../packages/flight-store/node_modules/postgres/src/index.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url, { max: 1, ssl: "require" });

const trips = await sql`
  select
    t.id,
    t.title,
    t.status,
    t.brief->>'currency' as currency,
    t.brief->'originAirports' as origins,
    t.brief->'destinationAirports' as destinations,
    t.brief->>'tripType' as trip_type,
    t.brief->'departureWindow' as departure_window,
    t.brief->>'maxStops' as max_stops,
    t.updated_at,
    w.id as watch_id,
    w.status as watch_status,
    w.next_check_at,
    w.last_check_at,
    w.delayed_at,
    w.delay_reason
  from captain.trips t
  left join captain.watches w on w.trip_id = t.id
  where t.status not in ('cancelled', 'completed', 'archived')
  order by t.updated_at desc
  limit 20
`;

const specs = await sql`
  select
    ss.id as search_spec_id,
    ss.request->>'provider' as provider,
    ss.request->>'currency' as currency,
    ss.request->>'maxConnections' as max_connections,
    ss.request->'slices' as slices,
    link.watch_id,
    t.id as trip_id,
    t.title
  from captain.search_specs ss
  join captain.watch_search_specs link on link.search_spec_id = ss.id
  join captain.watches w on w.id = link.watch_id
  join captain.trips t on t.id = w.trip_id
  where t.status not in ('cancelled', 'completed', 'archived')
`;

const offers = await sql`
  select
    o.search_spec_id,
    count(*)::int as offer_count,
    min(o.price) as min_price,
    max(o.currency) as currency
  from captain.offers o
  join captain.watch_search_specs link on link.search_spec_id = o.search_spec_id
  join captain.watches w on w.id = link.watch_id
  join captain.trips t on t.id = w.trip_id
  where t.status not in ('cancelled', 'completed', 'archived')
  group by o.search_spec_id
`;

const runs = await sql`
  select
    r.id,
    r.search_spec_id,
    r.status,
    r.attempt,
    r.error,
    r.provider_offer_count,
    r.retained_offer_count,
    r.scheduled_at,
    r.started_at,
    r.completed_at
  from captain.search_runs r
  join captain.watch_search_specs link on link.search_spec_id = r.search_spec_id
  join captain.watches w on w.id = link.watch_id
  join captain.trips t on t.id = w.trip_id
  where t.status not in ('cancelled', 'completed', 'archived')
  order by coalesce(r.completed_at, r.scheduled_at) desc nulls last
  limit 30
`;

console.log(JSON.stringify({
  tripCount: trips.length,
  trips,
  specs,
  offers,
  recentRuns: runs
}, null, 2));

await sql.end({ timeout: 5 });
