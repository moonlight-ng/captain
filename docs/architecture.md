# Pilot + Captain architecture

## Deployment and data boundaries

`apps/pilot`, `apps/captain`, and `apps/flight-worker` are independently
deployable. Pilot keeps its existing private Supabase project, secrets, prompt,
tools, Telegram webhook, and `opemipo-captain` Fly app. Its Markdown state uses
the `pilot_data` volume mounted at `/data`, with memory under `/data/pilot`.
Captain and the worker share Captain’s PostgreSQL database and public Telegram
bot token, but run as separate processes. No app imports another app.

Shared packages contain only stable cross-runtime contracts and deterministic
logic. Pilot already consumes the shared Trip brief and observability packages;
Captain and the worker share the full flight domain and store contracts.

## Conversation and Trip flow

Captain validates Telegram’s webhook secret, resolves the Telegram user ID to
an active Captain user, and claims a durable message idempotency key. New users
are active by default; explicitly suspended users cannot continue. The model
receives only that user’s recent messages, active
Trip, and Trip list. Trip tools derive the user from signed session attributes,
never from model or client input.

Trips use optimistic versions and append events for creates, updates, and
lifecycle actions. Exact active-Trip retries are reused, preventing duplicate
Trips from webhook retries or repeated tool execution. Ambiguous references
must be clarified before mutation.

## Search and orchestration flow

Each Trip has one individual Watch. A Watch expands into at most 24 canonical
SearchSpecs. The complete Duffel request—including version, live mode, ordered
slices, passenger types or ages, cabin, connection limit, and fare context—is
hashed. Many Watches can subscribe to one hash.

The always-on orchestrator checks due Watches every 60 seconds. Transactional
leases and a global advisory lock cap active runs at four. Each worker claims
immediately before execution and makes only one Duffel request at a time.
Completed results are stored once as canonical itineraries, ephemeral offers,
and append-only observations. Expired offers remain evidence but disappear
from current results.

Fresh shared results can satisfy a newly created matching Trip without another
provider call. Ranking then runs per Trip, accounting for price limits,
excluded and preferred airlines, stops, and duration.

## Notifications

Initial results, price drops of at least five percent, genuinely stronger new
itineraries, and terminal Watch errors create deterministic deduplication keys.
Non-critical messages wait through user quiet hours. Delivery is retried three
times and uses the Captain bot only; Pilot-owned Trips continue through Pilot’s
existing response flow and do not receive messages from the public bot.

## Compatibility

Legacy Flight Agent records migrate to Trips owned by the dedicated Pilot
principal. Legacy keys remain aliases. The former schema and
`/internal/v1/flight-agents` routes remain read-only/compatible for one release,
while Pilot now creates and refreshes Trips through `/internal/v1/trips`.
