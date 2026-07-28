# Duffel flight inventory

Primary structured fare provider for Captain. Supports Trips in **USD or GBP**
only. Routes or airlines Duffel does not cover return empty offer sets; the
worker sends a one-shot inventory-gap notice and keeps tracking.

When Duffel’s offer currency differs from the Trip currency, amounts convert
via open.er-api.com (USD↔GBP only). Evidence titles keep the original Duffel
amount and FX rate.

Requires `DUFFEL_ACCESS_TOKEN`.
