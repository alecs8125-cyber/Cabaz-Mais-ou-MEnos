---
name: PostgREST store filter batching
description: Keep location-based comparison requests below the HTTP request limits when many physical stores match.
---

When comparing prices for a broad manual location, do not send every matching store ID in one PostgREST `in` filter. Split store IDs into bounded batches and merge the verified results; keep Continente Online included regardless of physical location filters.

**Why:** A live app-service read for a broad Lisbon location failed with Node's `UND_ERR_HEADERS_OVERFLOW` while product and store reads succeeded. Batching the store IDs allowed the real price read and comparison to complete.

**How to apply:** Preserve all selected stores, batch their IDs before adding them to a price query, and verify with a broad location on live data.