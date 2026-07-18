# Independent Flight Agents

Captain's former flight-selection apps have moved to the standalone Flight
Agent service. Captain no longer searches Duffel, schedules fare watches, or
stores new flight observations.

## Captain tools

- `start_flight_agent` creates a trip-specific agent from a normalized airport,
  date-window, traveller, cabin, stop, budget, and airline brief.
- `get_flight_agent` retrieves one agent's status, latest check, notable flights,
  price changes, research, and workspace URL.
- `list_flight_agents` retrieves paginated summaries and agent keys.
- `refresh_flight_agent` requests a live Duffel fare check.
- `research_flight_agent` requests a live Duffel fare check followed by
  Captain's isolated Codex research.

The tools call `/internal/v1/flight-agents` on Flight Agent with timestamped
HMAC-SHA256 signatures and idempotency keys. Captain does not expose one-off
flight search or remote pause/cadence controls.

## Research bridge

Flight Agent calls Captain's `/internal/v1/codex/research` route only after an
explicit `fare_and_research` check. The request contains only public itinerary facts and
non-identifying constraints. Captain reuses its isolated Codex CLI login and
returns the existing structured, sourced research result plus sanitized model,
token-count, and duration metadata. Prompts and raw CLI output are not stored.
Failure is reported as partial check success; observed fares remain valid.

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
