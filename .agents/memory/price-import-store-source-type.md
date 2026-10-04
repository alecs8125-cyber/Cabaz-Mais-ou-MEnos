---
name: Price/store source separation
description: Keep the origin of a price feed separate from the namespace of a store's external identifier.
---

Price-feed `sourceType` and store `source_type` are distinct values. A price feed may identify a store using an ID from a separate namespace such as OpenStreetMap.

**Why:** Reusing the price source type for the store lookup can silently query the wrong `stores.source_type` namespace.

**How to apply:** Carry a separate `storeSourceType` on normalized observations and pass it to the exact store resolver.