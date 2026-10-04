---
name: Auchan price scope
description: Safety boundary for using public Auchan Portugal prices in Cabaz.
---

Treat Auchan's public pre-login product prices as reference-only for delivery or collection at postal code 2650-435, Amadora. After login, prices depend on the serving store and postal code. Do not treat the public price as a generic national Auchan Online price or create an Auchan Online store unless a valid, explicitly scoped store identity and an idempotent write contract are established.

**Why:** Auchan's public pricing notice limits the pre-login reference price to one postal code, while login-dependent prices vary by serving store and postal code.

**How to apply:** Keep public-page ingestion GET-only and dry-run-only under the current evidence. Before any price write, establish the intended postal/store scope, verify store and price identity uniqueness, and extend the server-side price RPC to authorize Auchan without weakening Continente's existing constraints.