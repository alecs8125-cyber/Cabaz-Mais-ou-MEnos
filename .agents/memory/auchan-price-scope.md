---
name: Auchan price scope
description: Safety boundary for using public Auchan Portugal prices in Cabaz.
---

Treat Auchan's public pre-login product prices as reference-only for delivery or collection at postal code 2650-435, Amadora. After login, prices depend on the serving store and postal code. Do not treat the public price as a generic national Auchan Online price or create an Auchan Online store unless a valid, explicitly scoped store identity and an idempotent write contract are established.

**Why:** Auchan's public pricing notice limits the pre-login reference price to one postal code, while login-dependent prices vary by serving store and postal code.

**How to apply:** Keep public-page ingestion GET-only, with dry-run as the default. Writes require explicit task authorization and a bounded, resumable path that verifies the postal scope, identity uniqueness, freshness, stable rereads, and GET readback through the existing server-side RPC. Never use the postal-code setter, broaden to national or physical-store scope, or create another store.

The public sitemap can contain invalid, missing, or non-product entries, so a page-request budget is not a count of stable or importable products.

**Why:** URL requests can be spent on entries that do not produce a valid product, and stability rereads consume additional requests.

**How to apply:** Keep scan budgets separate from eligible-product limits. Advance the bookmark only after complete, stable validation; block writes on scope, identity, freshness, availability, or mapping failures, and rerun the sample in dry-run mode after a commit.