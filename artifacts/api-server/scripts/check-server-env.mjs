// Print presence only. Never log credentials or their length.
const supabaseUrlPresent = Boolean(
  process.env.SUPABASE_URL?.trim() ||
  process.env.EXPO_PUBLIC_SUPABASE_URL?.trim(),
);
const serviceRolePresent = Boolean(
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
);

console.log(JSON.stringify({ supabaseUrlPresent, serviceRolePresent }));