---
name: Supabase request retries
description: Keeping catalogue network failures explicit when both React Query and the Supabase SDK can retry.
---

Treat React Query and PostgREST as separate retry layers. An explicit “Tentar novamente” flow should not silently keep retrying beneath the query hook.

**Why:** The installed Supabase SDK retried a failed GET three times with backoff even though React Query had retries disabled. The catalogue kept showing loading during these attempts instead of promptly presenting its error and retry button. Query-chain mocks alone did not reveal this SDK behavior.

**How to apply:** Check the installed SDK's supported retry controls and disable transport retries for requests whose recovery is intentionally user-driven. Configure catalogue queries to attempt requests even when the browser reports offline, so a paused query does not masquerade as endless loading. Include a real-SDK transport-failure check when changing this behavior; successful response data must still come from Supabase, never a local fallback.