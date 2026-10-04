---
name: PostgREST exact filters
description: Correct exact-value encoding in manually constructed Supabase REST queries.
---

For simple text filters, use the `eq.<value>` form with normal URL query encoding; do not wrap every value in quotes.

**Why:** In a live read, `eq."openstreetmap"` returned no rows while `eq.openstreetmap` matched the same active stores. Quoting a plain value changed the equality match.

**How to apply:** When constructing PostgREST filters manually, follow the semantics of `.eq()` and validate exact filters against text identifiers. Apply special-character escaping only where PostgREST requires it, rather than quoting every value.