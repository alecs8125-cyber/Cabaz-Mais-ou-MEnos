---
name: Expo dependency checks
description: Interpreting Expo compatibility recommendations when newly released patches are blocked by package age policy.
---

Expo's online dependency check can recommend same-day patches that the workspace's minimum-release-age policy does not yet permit. Do not bypass that safeguard or treat every latest-patch recommendation as proof that the installed application is broken.

**Why:** The online recommendation can advance ahead of both the installed SDK's bundled compatibility metadata and the package manager's permitted releases. Repeatedly forcing the suggested update does not resolve that difference.

**How to apply:** Keep separate evidence for the installed SDK's compatibility, actual app startup and the availability of newer patches. Offline checks only assess bundled metadata; they do not prove agreement with the latest online recommendation. Report any blocked update accurately and preserve package security settings.