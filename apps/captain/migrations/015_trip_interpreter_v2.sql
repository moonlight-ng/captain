alter table captain.trip_plan_drafts
  add column if not exists turn_state jsonb not null default '{
    "version": 2,
    "pendingFields": [],
    "lastPrompt": null,
    "repeatedPromptCount": 0,
    "fieldSources": {},
    "interpreterVersion": "trip_interpreter_v2",
    "parser": null,
    "model": null,
    "lastIntent": null,
    "lastOperations": []
  }'::jsonb;
