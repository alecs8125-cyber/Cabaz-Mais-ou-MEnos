---
name: Expo Supabase service checks
description: Plain Node integration checks can fail on the mobile client's React Native polyfill before reaching Supabase.
---

Do not treat a plain Node import failure of the compiled Expo Supabase client as proof that the application cannot load prices.

**Why:** The mobile client imports `react-native-url-polyfill/auto`; requiring that compiled module in Node can lead to React Native's Flow-syntax entrypoint, which Node cannot parse. The Expo bundle and actual mobile-web comparison worked despite this isolated test-harness failure.

**How to apply:** For a Node-only service check, substitute the shared client module with a Supabase client configured from the same existing development environment; validate the actual Expo bundle or UI separately. Do not remove the mobile polyfill to make a Node probe pass.