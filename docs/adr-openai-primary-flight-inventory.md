# ADR: OpenAI-primary flight inventory

## Status

Accepted — 2026-07-27

## Context

Captain needs storeable flight offers for ranking and Telegram alerts. Two inventory approaches exist:

1. **Duffel** — structured offers, but prices return in the organisation **billing currency** (Captain: GBP). Local Nigerian domestic coverage is weak. Changing billing currency is an ops/support action, not a per-request API parameter.
2. **`openai_web`** — OpenAI Responses + `web_search` with Trip-constraint validation. Works in the traveller’s confirmed currency, including NGN and USD, but an over-strict two-pass/evidence gate was returning empty sets even when ChatGPT’s chat UI could narrate options.

Silent FX conversion is forbidden: Trip currency is immutable and fares must not be converted in the store.

## Decision

1. **`openai_web` is the primary inventory path** for domestic, regional, and international Trips in whatever currency the traveller confirmed.
2. **Duffel (`official_duffel`) is optional and deferred.** It is not part of the public request path. Restoring an official adapter is backlog, not a launch blocker.
3. **Do not steer travellers into GBP** so Duffel can run. Suggest NGN for single-country NG domestic routes; otherwise use the profile default.
4. **ChatGPT chat is not the quality bar.** Captain needs structured, constraint-checked offers. Web validation keeps route/date/cabin/currency/fare checks but does not require bit-identical evidence URLs across passes or exact URL membership when a same-domain source was retrieved.
5. **Empty verified sets must not wipe last good offers.**

## Consequences

- Launch eval and worker ops center on `openai_web` coverage.
- Cross-border Trips default to `maxStops = 2`; domestic defaults to `1`.
- Root product docs describe OpenAI web research as primary inventory; Duffel is optional enrichment when currency aligns.
- Unofficial metasearch scraping remains forbidden.
