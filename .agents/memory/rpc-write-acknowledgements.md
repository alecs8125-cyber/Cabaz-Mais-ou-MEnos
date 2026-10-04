---
name: RPC write acknowledgements
description: Safe reconciliation when a real Supabase mutation persists data but its response fails the importer’s expected contract.
---

A mutation's response-validation failure means the persisted state is uncertain, not that the mutation failed. For a one-shot authorized import, reconcile products, mappings, prices and history through read-only requests before considering any retry. Do not replay a mutation merely to discover its response shape.

The deployed Continente price RPC returns a bare UUID JSON string. The checked-in SQL definition also documents a detailed JSON object response; keep both accepted shapes exact. A UUID acknowledges a price ID, but does not confirm history-created or 36-hour-validity flags, so those counts remain unknown until a GET verification.

**Why:** The deployed Continente price RPC persisted prices and their initial history while the importer rejected its returned representation and reported unconfirmed zero write counts. A successful parameter/index preflight did not establish response-contract compatibility.

**How to apply:** Keep the authorized commit count unchanged, compare pre/post read snapshots, and report confirmed persisted counts separately from client acknowledgement errors. Align the deployed and client response contracts in a separate explicitly scoped change; do not hide the mismatch or assume the local SQL definition matches the deployed function.