alter table captain.trip_plan_drafts
  add column draft_state jsonb,
  add column confirmation_snapshot jsonb;

update captain.trip_plan_drafts as draft
set
  draft_state = jsonb_build_object(
    'version', 3,
    'tripType', draft.partial -> 'tripType',
    'legs', case
      when jsonb_typeof(draft.partial -> 'legs') = 'array'
        and jsonb_array_length(draft.partial -> 'legs') > 0
      then (
        select jsonb_agg(
          jsonb_build_object(
            'originAirports', coalesce(leg -> 'originAirports', '[]'::jsonb),
            'destinationAirports', coalesce(leg -> 'destinationAirports', '[]'::jsonb),
            'departure', case
              when jsonb_typeof(leg -> 'departureDate') = 'string'
              then jsonb_build_object('kind', 'exact', 'date', leg -> 'departureDate')
              else 'null'::jsonb
            end
          )
          order by ordinal
        )
        from jsonb_array_elements(draft.partial -> 'legs') with ordinality as item(leg, ordinal)
      )
      when coalesce(draft.partial -> 'originAirports', '[]'::jsonb) <> '[]'::jsonb
        or coalesce(draft.partial -> 'destinationAirports', '[]'::jsonb) <> '[]'::jsonb
        or jsonb_typeof(draft.partial -> 'departureDate') = 'string'
      then jsonb_build_array(jsonb_build_object(
          'originAirports', coalesce(draft.partial -> 'originAirports', '[]'::jsonb),
          'destinationAirports', coalesce(draft.partial -> 'destinationAirports', '[]'::jsonb),
          'departure', case
            when jsonb_typeof(draft.partial -> 'departureDate') = 'string'
            then jsonb_build_object('kind', 'exact', 'date', draft.partial -> 'departureDate')
            else 'null'::jsonb
          end
        ))
        || case
          when draft.partial ->> 'tripType' = 'round_trip'
            and jsonb_typeof(draft.partial -> 'returnDate') = 'string'
          then jsonb_build_array(jsonb_build_object(
            'originAirports', coalesce(draft.partial -> 'destinationAirports', '[]'::jsonb),
            'destinationAirports', coalesce(draft.partial -> 'originAirports', '[]'::jsonb),
            'departure', jsonb_build_object(
              'kind', 'exact',
              'date', draft.partial -> 'returnDate'
            )
          ))
          else '[]'::jsonb
        end
      else '[]'::jsonb
    end,
    'travellers', coalesce(draft.partial -> 'travellers', 'null'::jsonb),
    'cabin', coalesce(draft.partial -> 'cabin', 'null'::jsonb),
    'maxStops', coalesce(draft.partial -> 'maxStops', 'null'::jsonb),
    'currency', coalesce(draft.partial -> 'currency', 'null'::jsonb),
    'maximumPrice', coalesce(draft.partial -> 'maximumPrice', 'null'::jsonb),
    'preferredAirlines', coalesce(draft.partial -> 'preferredAirlines', '[]'::jsonb),
    'excludedAirlines', coalesce(draft.partial -> 'excludedAirlines', '[]'::jsonb)
  ),
  confirmation_snapshot = draft.plan;

alter table captain.trip_plan_drafts
  alter column draft_state set default '{
    "version": 3,
    "tripType": null,
    "legs": [],
    "travellers": null,
    "cabin": null,
    "maxStops": null,
    "currency": null,
    "maximumPrice": null,
    "preferredAirlines": [],
    "excludedAirlines": []
  }'::jsonb,
  alter column draft_state set not null;

alter table captain.trip_plan_drafts
  drop column partial,
  drop column plan,
  drop column unresolved_fields,
  drop column inferred_fields,
  drop column turn_state;
