---
name: Continente price scope
description: Safe treatment of public Continente product-page prices and physical-store identity.
---

Continente public product pages provide an online price, but the observed product data does not establish a safe physical-store identity. Preserve `priceScope = "online"` and never assign these observations to a physical store. The user now authorizes a separate logical channel identified exactly as `continente + online`, displayed as “Continente Online”.

**Why:** A public online price must not be presented as the price of every physical Continente store. The existing Cabaz comparison path is store-based.

**How to apply:** Resolve only the explicitly authorized logical online channel; never substitute a physical store, distance or locality. Keep physical-store filtering unchanged. The current authorized scope and freshness policy are documented in `replit.md`.