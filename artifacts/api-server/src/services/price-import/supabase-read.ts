export type SupabaseReadTable =
  | "products"
  | "stores"
  | "external_product_mappings"
  | "prices"
  | "price_history";

export interface SupabaseReadOnlyClient {
  getRows(
    table: SupabaseReadTable,
    query: Readonly<Record<string, string>>,
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface SupabaseReadConfig {
  readonly url: string;
  readonly publishableKey: string;
}

function validateConfig(config: SupabaseReadConfig): SupabaseReadConfig {
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) {
    throw new Error(
      "A leitura Supabase requer EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY com prefixo sb_publishable_.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    throw new Error("EXPO_PUBLIC_SUPABASE_URL tem um formato inválido.");
  }

  if (
    !["https:", "http:"].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "EXPO_PUBLIC_SUPABASE_URL deve ser uma URL HTTP/HTTPS sem credenciais ou parâmetros.",
    );
  }

  return {
    url: parsedUrl.toString().replace(/\/+$/, ""),
    publishableKey: config.publishableKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SupabaseRestReadClient implements SupabaseReadOnlyClient {
  private readonly baseUrl: string;
  private readonly publishableKey: string;

  constructor(
    config: SupabaseReadConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const validated = validateConfig(config);
    this.baseUrl = validated.url;
    this.publishableKey = validated.publishableKey;
  }

  async getRows(
    table: SupabaseReadTable,
    query: Readonly<Record<string, string>>,
  ): Promise<readonly Record<string, unknown>[]> {
    const url = new URL(`/rest/v1/${table}`, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    // Publishable keys identify the anon role through apikey. No user JWT,
    // service key, session, retry, or mutation method is used by this client.
    const response = await this.fetchImplementation(url, {
      method: "GET",
      headers: {
        apikey: this.publishableKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `A leitura de public.${table} falhou com HTTP ${response.status}.`,
      );
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.some((row) => !isRecord(row))) {
      throw new Error(`O Supabase devolveu uma resposta inválida para public.${table}.`);
    }

    return body;
  }
}

export function createSupabaseRestReadClient(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): SupabaseRestReadClient {
  const url = environment.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey =
    environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url) {
    throw new Error("Falta EXPO_PUBLIC_SUPABASE_URL.");
  }
  if (!publishableKey) {
    throw new Error("Falta EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }

  return new SupabaseRestReadClient(
    { url, publishableKey },
    fetchImplementation,
  );
}