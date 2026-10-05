import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const command = fileURLToPath(new URL("../scripts/check-server-env.mjs", import.meta.url));
const run = (env) => spawnSync(process.execPath, [command], {
  encoding: "utf8",
  env: { PATH: process.env.PATH, ...env },
});

test("env diagnostic prints only false/true booleans and never echoes credentials", () => {
  const credentialMarker = "must-never-appear-in-output";
  const missing = run({});
  assert.equal(missing.status, 0);
  assert.deepEqual(JSON.parse(missing.stdout), {
    supabaseUrlPresent: false,
    serviceRolePresent: false,
  });

  const present = run({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: credentialMarker,
  });
  assert.equal(present.status, 0);
  assert.deepEqual(JSON.parse(present.stdout), {
    supabaseUrlPresent: true,
    serviceRolePresent: true,
  });
  assert.equal(present.stdout.includes(credentialMarker), false);
  assert.equal(present.stdout.includes("SUPABASE_URL="), false);
});

test("whitespace-only values are reported absent", () => {
  const result = run({ SUPABASE_URL: "  ", SUPABASE_SERVICE_ROLE_KEY: "\t " });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    supabaseUrlPresent: false,
    serviceRolePresent: false,
  });
});

test("EXPO_PUBLIC_SUPABASE_URL is only a development fallback", () => {
  const legacy = "https://development.supabase.co";
  const production = run({
    NODE_ENV: "production",
    EXPO_PUBLIC_SUPABASE_URL: legacy,
  });
  assert.equal(production.status, 0);
  assert.deepEqual(JSON.parse(production.stdout), {
    supabaseUrlPresent: false,
    serviceRolePresent: false,
  });

  const development = run({
    NODE_ENV: "development",
    EXPO_PUBLIC_SUPABASE_URL: legacy,
  });
  assert.equal(development.status, 0);
  assert.deepEqual(JSON.parse(development.stdout), {
    supabaseUrlPresent: true,
    serviceRolePresent: false,
  });
});