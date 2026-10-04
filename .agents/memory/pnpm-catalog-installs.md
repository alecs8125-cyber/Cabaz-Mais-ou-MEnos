---
name: pnpm catalog installs
description: Avoiding unrelated shared-workspace changes when adding a catalog dependency to one artifact.
---

Check shared catalog changes after adding an existing catalog package to a single artifact. A filtered install is not a guarantee that only that artifact's dependency declaration changes.

**Why:** The workspace's pnpm installation rewrote the shared catalog constraint and normalized the entire workspace YAML, removing explanatory security comments, during an artifact-scoped dependency addition. The requested artifact did not require those shared changes.

**How to apply:** Preserve the existing shared version constraint and security guidance, declare the artifact dependency using `catalog:`, and synchronize the lockfile without accepting unrelated catalog or configuration rewrites. Do not disable package release-age safeguards.