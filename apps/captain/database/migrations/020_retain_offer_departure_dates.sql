-- Per-date fare comparisons depend on preserving the exact dates searched for
-- each retained offer. The application compactor already keeps this field; the
-- database trigger must mirror that allowlist rather than silently removing it.
create or replace function captain.compact_offer_snapshot()
returns trigger
language plpgsql
as $$
begin
  new.snapshot = jsonb_strip_nulls(jsonb_build_object(
    'route', left(coalesce(new.snapshot ->> 'route', ''), 300),
    'departureDates', coalesce(new.snapshot -> 'departureDates', '[]'::jsonb),
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
