import type {
  ContinenteExternalProductMapping,
  ContinenteMappingRepository,
} from "./continente-types.js";
import type {
  SupabaseReadOnlyClient,
  SupabaseReadTable,
} from "./supabase-read.js";

const ALLOWED_TABLES = new Set<SupabaseReadTable>([
  "products",
  "stores",
  "external_product_mappings",
  "prices",
  "price_history",
]);

export interface SupabaseAuchanReadConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(config: SupabaseAuchanReadConfig): SupabaseAuchanReadConfig {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("EXPO_PUBLIC_SUPABASE_URL has an invalid format.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) throw new Error("EXPO_PUBLIC_SUPABASE_URL must be an HTTP(S) URL without credentials or parameters.");
  if (!config.serviceRoleKey.trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for private, read-only mapping lookup.");
  }
  return {
    url: url.toString().replace(/\/+$/, ""),
    serviceRoleKey: config.serviceRoleKey,
  };
}

/**
 * Service-role access is deliberately limited to GET requests. This client has
 * no POST, PATCH, DELETE, RPC, retry, or SQL execution path.
 */
export class SupabaseAuchanReadClient implements SupabaseReadOnlyClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(
    config: SupabaseAuchanReadConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const validated = readConfig(config);
    this.baseUrl = validated.url;
    this.serviceRoleKey = validated.serviceRoleKey;
  }

  async getRows(
    table: SupabaseReadTable,
    query: Readonly<Record<string, string>>,
  ): Promise<readonly Record<string, unknown>[]> {
    if (!ALLOWED_TABLES.has(table)) throw new Error("Read-only table is not allowlisted.");
    const url = new URL(`/rest/v1/${table}`, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchImplementation(url, {
      method: "GET",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Read-only GET public.${table} failed with HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.some((row) => !isRecord(row))) {
      throw new Error(`Supabase returned an invalid public.${table} read response.`);
    }
    return body;
  }

  async getOpenApiSchema(): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(
      new URL("/rest/v1/", this.baseUrl),
      {
        method: "GET",
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          accept: "application/openapi+json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Read-only OpenAPI GET failed with HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("Supabase returned an invalid OpenAPI document.");
    return body;
  }

  async getRpc(name: "auchan_sync_capabilities"): Promise<unknown> {
    const response = await this.fetchImplementation(
      new URL(`/rest/v1/rpc/${name}`, this.baseUrl),
      {
        method: "GET",
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Read-only GET public.${name} failed with HTTP ${response.status}.`);
    }
    return response.json();
  }
}

export function createSupabaseAuchanReadClient(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): SupabaseAuchanReadClient {
  const url = environment.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL.");
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  return new SupabaseAuchanReadClient(
    { url, serviceRoleKey },
    fetchImplementation,
  );
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  throw new Error(`public.external_product_mappings.${field} was not text or null.`);
}

export class SupabaseAuchanMappingRepository implements ContinenteMappingRepository {
  constructor(private readonly client: SupabaseReadOnlyClient) {}

  async findMappings(
    sourceType: string,
    externalProductId: string,
  ): Promise<readonly ContinenteExternalProductMapping[]> {
    if (sourceType !== "auchan") return [];
    const rows = await this.client.getRows("external_product_mappings", {
      select: "source_type,external_product_id,product_id,match_method,confidence,verified",
      source_type: "eq.auchan",
      external_product_id: `eq.${externalProductId}`,
      limit: "2",
    });
    return rows.map((row) => {
      const mappedSource = nullableText(row.source_type, "source_type");
      const mappedId = nullableText(row.external_product_id, "external_product_id");
      const productId = nullableText(row.product_id, "product_id");
      const matchMethod = nullableText(row.match_method, "match_method");
      if (
        !mappedSource ||
        !mappedId ||
        !productId ||
        !matchMethod ||
        typeof row.verified !== "boolean" ||
        !Number.isFinite(Number(row.confidence))
      ) throw new Error("Invalid external-product mapping row.");
      return {
        sourceType: mappedSource,
        externalProductId: mappedId,
        productId,
        matchMethod,
        confidence: Number(row.confidence),
        verified: row.verified,
      };
    });
  }
}