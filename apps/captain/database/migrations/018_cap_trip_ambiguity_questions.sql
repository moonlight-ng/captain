update captain.trip_plan_drafts
set draft_state = jsonb_set(draft_state, '{questionsAsked}', '0'::jsonb, true)
where not (draft_state ? 'questionsAsked');

alter table captain.trip_plan_drafts
  alter column draft_state set default '{
    "version": 3,
    "questionsAsked": 0,
    "tripType": null,
    "legs": [],
    "travellers": null,
    "cabin": null,
    "maxStops": null,
    "currency": null,
    "maximumPrice": null,
    "preferredAirlines": [],
    "excludedAirlines": []
  }'::jsonb;
