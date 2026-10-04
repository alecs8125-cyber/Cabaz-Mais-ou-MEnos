---
name: Server secrets propagation
description: Distinguish Replit Secrets from normal .replit user environment variables when a workflow receives a credential but the Secret inventory does not.
---

Credentials in `.replit` `[userenv.shared]` can reach workspace shells and workflow processes while remaining ordinary, source-controlled environment configuration. A process reporting the variable as present does not establish that it is stored in Replit Secrets. Check the Secret inventory separately, inspect configuration for the variable name without printing values, and verify the restarted workflow/child process using presence-only output.

**Why:** A service-role JWT was present in `.replit` and inherited by the API and sync process, while the Secret inventory reported it absent. Exposing the JWT in tracked configuration required removal and key rotation rather than using it for an import.

**How to apply:** Store privileged credentials only in Replit Secrets, never in `.replit` or `userenv.shared`. Remove normal-variable copies, restart workflows so stale processes do not retain them, and use a value-free diagnostic before database operations. Treat any credential exposed in Git or tool output as compromised and rotate it.