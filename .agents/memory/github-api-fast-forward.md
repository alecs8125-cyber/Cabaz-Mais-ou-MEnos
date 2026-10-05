---
name: GitHub API fast-forward
description: Safely publish a local commit through the connected GitHub App when direct git push lacks credentials.
---

When a direct `git push` cannot authenticate but the GitHub App is authorized, create the Git tree and commit through the GitHub REST API only after confirming the remote branch points to the local commit's parent. GitHub's create-commit API preserves the message bytes; include the final newline from a normal local Git commit or the resulting commit SHA will differ even if its tree, parent, author, committer, and visible message match. Compare the created tree and commit SHAs to the local objects before changing a ref. Re-read the branch immediately before updating it, PATCH with `force: false`, then verify the remote SHA.

**Why:** A commit with a different SHA but identical files would leave the local branch and remote branch diverged, complicating future pushes.

**How to apply:** Prefer ordinary `git push` first. Use the connected GitHub App only as a fallback; never move the remote ref unless its current SHA is still the expected parent and the new commit matches the local commit.
