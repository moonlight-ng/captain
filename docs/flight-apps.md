# Independent Flight Agents

Captain's former flight-selection apps have moved to the standalone Flight
Agent service. Captain no longer searches Duffel, schedules fare watches, or
stores new flight observations.

## Captain tools

- `plan_trip` loads flight memory only for the planning workflow, reconciles a
  natural-language request into a durable trip draft, and sends the complete
  brief for explicit confirmation. The Telegram **Start tracking** callback is
  the only path that creates a trip-specific Flight Agent.
- `get_flight_agent` retrieves one agent's status, latest check, notable flights,
  price changes, research, and workspace URL.
- `list_flight_agents` retrieves paginated summaries and agent keys.
- `refresh_flight_agent` requests a live multi-source fare check.
- `research_flight_agent` is retained for compatibility and requests the same
  complete Duffel plus Codex fare check.

The bridge calls `/internal/v1/flight-agents` on Flight Agent with timestamped
HMAC-SHA256 signatures and deterministic idempotency keys. Creation responses
include current total-party price ranges calculated from all current browse
results. Captain does not expose one-off flight search or remote pause/cadence
controls.

## Research bridge

Flight Agent calls Captain's `/internal/v1/codex/research` route alongside every
Duffel check. The request contains only public itinerary facts and
non-identifying constraints. Captain reuses its isolated Codex CLI login and
returns sourced context plus strictly structured, exact-itinerary web offers
with sanitized model, token-count, and duration metadata. Prompts and raw CLI
output are not stored. Flight Agent merges verified offers into the same
canonical itinerary and price-observation history used for Duffel. Either
source may complete independently; one source failing produces a partial check
without discarding the other source's fares.

## Legacy links and data

`/apps/:appKey` and `/workspaces/:appKey` permanently redirect to
`{FLIGHT_AGENT_BASE_URL}/agents/:appKey`. The one-time Flight Agent importer
preserves selection app keys and converts candidates, observations, decisions,
and events. Captain's historical flight tables and migrations remain read-only
for rollback.

During cutover, configure distinct `CAPTAIN_TO_FLIGHT_AGENT_SECRET` and
`FLIGHT_AGENT_TO_CAPTAIN_SECRET` values in both apps. After the import has been
verified and Flight Agent completes a live Duffel check, remove Captain's
legacy `DUFFEL_*` Fly secrets; only Flight Agent should retain them.
