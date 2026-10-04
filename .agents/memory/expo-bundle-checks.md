---
name: Expo bundle checks
description: Verifying mobile compilation when a shared-workspace service already occupies Metro's default build port.
---

Distinguish a non-interactive Expo build script's port conflict from an application compilation error.

**Why:** A static build script may try to start Metro on its default port while another artifact owns that port. The script then fails at an interactive “use another port?” prompt, even though the mobile app's managed preview is running and its iOS bundle compiles.

**How to apply:** Verify which service owns the port; do not stop another artifact or change build settings solely to satisfy a one-off compile check. A direct, non-interactive Expo export to a temporary iOS output directory checks the native bundle independently. Report any failed package build script separately rather than claiming it passed.