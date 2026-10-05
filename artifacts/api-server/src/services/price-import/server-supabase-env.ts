export type ServerEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Server processes use SUPABASE_URL. The Expo-prefixed URL is accepted only
 * when explicitly running in development for compatibility with local setups.
 */
export function resolveServerSupabaseUrl(environment: ServerEnvironment): string {
  const serverUrl = environment.SUPABASE_URL?.trim();
  if (serverUrl) return serverUrl;

  const developmentUrl = environment.NODE_ENV === "development"
    ? environment.EXPO_PUBLIC_SUPABASE_URL?.trim()
    : undefined;
  if (developmentUrl) return developmentUrl;

  throw new Error(
    "SUPABASE_URL is required for server-side Supabase access (EXPO_PUBLIC_SUPABASE_URL is a development-only fallback).",
  );
}
