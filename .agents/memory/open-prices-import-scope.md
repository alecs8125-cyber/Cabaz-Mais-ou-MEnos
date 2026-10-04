---
name: Open Prices import scope
description: Boundaries for the Open Prices price-import adapter.
---

Open Prices is authorized only as a public read-only source for dry-run validation. Do not add database writes or schema changes, SQL, scraping, supermarket sources, scheduled deployments, or changes to the Expo app.

**Why:** The user limited this work to validating Open Prices observations without modifying product data or the mobile app.

**How to apply:** Keep future work confined to API-server reads and dry-run validation. Ask before expanding any of these boundaries.