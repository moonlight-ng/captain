# ADR: Flysoar MCP fallback inventory

## Status

Accepted — 2026-07-30.

## Decision

1. `official_duffel` remains Captain's primary inventory provider.
2. `flysoar_mcp` is the automatic backup. The worker calls it only when the
   direct Duffel request fails or returns no offers.
3. Public searches use the stateless `soar_search_flights` MCP tool at
   `https://mcp.flysoar.ai/mcp`. No account or OAuth grant is required for
   search.
4. Flysoar prices its public flight results in USD. Captain converts fallback
   results into a GBP trip's confirmed currency through the same cached
   USD/GBP FX path used by the primary adapter.
5. The worker preserves the provider returned by the successful adapter, so
   fallback fares are stored as `flysoar_mcp` and retain their Soar offer IDs.
6. At most 60 diverse offers are retained for a search, regardless of which
   adapter produced them.

## Consequences

- The backup removes a dependency on model-driven web search and does not need
  an OpenAI API credential.
- Flysoar currently reports Duffel as its underlying public-search source. It
  protects Captain from direct API/path failures and differences in offer
  retrieval, but it is not an independent airline inventory supplier.
- Anonymous MCP search is rate-limited by Flysoar. Calling it only as a
  fallback keeps normal tracking on Captain's direct Duffel allocation.
- `https://flysoar.ai/mcp` is the installation page; the MCP transport is the
  `mcp.flysoar.ai` URL above.
