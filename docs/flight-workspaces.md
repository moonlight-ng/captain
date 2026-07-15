# Flight-selection workspaces

Captain's first goal-oriented workspace selects a booking-ready combination of
flights. The durable object is the goal; the workspace is its browser view.

## Link and access

Each goal has one stable URL:

```text
{CAPTAIN_EVE_PUBLIC_URL}/workspaces/{workspaceKey}
```

`workspaceKey` is a random, opaque 128-bit identifier. It contains no route,
date, or traveller information and is not an access credential. Captain serves
both `/workspaces` and the goal view itself. The internal browser uses Captain's
existing Basic owner credential; no separate frontend or public-site route is
required. API clients can also authenticate with Supabase. Captain accepts only
`CAPTAIN_WORKSPACE_OWNER_USER_ID`; if that immutable user ID is not configured
yet, it temporarily falls back to the authenticated user whose email matches
`OWNER_EMAIL`.

`GET /workspaces` is the goal index. It links to one stable detail route per
goal, so links are organized by outcome rather than by conversation, search,
or individual flight result.

## Read model

List workspaces:

```http
GET /v1/workspaces
Authorization: Bearer <supabase-access-token>
```

Read one workspace:

```http
GET /v1/workspaces?key=<workspaceKey>
Authorization: Bearer <supabase-access-token>
```

The response contains:

- `workspace`: goal identity, stable URL, phase, version, and agent status.
- `journey`: ordered routes, travellers, constraints, and ranking preference.
- `summary`: decision counts and live-search timestamp.
- `candidates`: observed cards including all flight routes; `current` marks the
  latest deck while older candidates remain addressable from history.
- `history`: the ordered append-only goal event stream.

The minimalist client renders each complete, possibly multi-route journey as a
card. It retains back/forward navigation locally and uses `history` for the
durable decision trail. Historical cards can be reopened but cannot receive
new actions. Viewing or navigating never changes goal knowledge.

## Discrete actions

```http
POST /v1/workspaces/actions
Authorization: Bearer <supabase-access-token>
Content-Type: application/json

{
  "workspaceKey": "opaque-key",
  "actionId": "client-generated-uuid",
  "expectedVersion": 3,
  "candidateId": "candidate-uuid",
  "action": "pass"
}
```

Supported actions are `pass`, `save`, `select`, and `undo`.

The swipe interaction is only a shortcut: left maps to `pass`, right maps to
`save`, and visible buttons expose the same actions without gestures.

- `actionId` makes retries idempotent.
- `expectedVersion` prevents decisions against stale workspace state.
- A version conflict returns HTTP 409 and the client must reload.
- `select` runs a fresh Duffel search before changing goal state.
- A changed price or unavailable itinerary returns HTTP 409 with the refreshed
  workspace instead of silently selecting a different result.
- A provider failure returns HTTP 503 while preserving the goal and its history.

Selection is deliberately separate from booking authority. A selected goal is
complete for this first slice, but no booking intent, payment, or ticket purchase
is created.
