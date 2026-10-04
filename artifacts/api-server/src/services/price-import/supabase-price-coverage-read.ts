import type { PriceCoverageAuditInput, PriceCoverageAuditRow } from "./price-coverage-audit.js";

export type PriceCoverageAuditTable =
  | "products"
  | "stores"
  | "external_product_mappings"
  | "prices";

export interface PriceCoverageReadClient {
  getRows(
    table: PriceCoverageAuditTable,
    query: Readonly<Record<string, string>>,
  ): Promise<readonly PriceCoverageAuditRow[]>;
}

export interface PriceCoverageReadConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

const ALLOWED_TABLES = new Set<PriceCoverageAuditTable>([
  "products",
  "stores",
  "external_product_mappings",
  "prices",
]);
const TABLE_SELECTS: Readonly<Record<PriceCoverageAuditTable, string>> = {
  products: "id,source_type,external_id,active",
  stores: "id,name,active,store_type,source_type,external_id,district,municipality,parish,latitude,longitude,postal_code,chain_name",
  external_product_mappings: "id,source_type,external_product_id,product_id",
  prices: "id,product_id,store_id,source_type,external_id,verification_status,captured_at,valid_from,valid_until",
};
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS_PER_TABLE = 250_000;

function validateConfig(config: PriceCoverageReadConfig): PriceCoverageReadConfig {
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
  ) {
    throw new Error("EXPO_PUBLIC_SUPABASE_URL must be HTTP(S) without credentials or parameters.");
  }
  if (!config.serviceRoleKey.trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the read-only audit.");
  }
  return {
    url: url.toString().replace(/\/+$/, ""),
    serviceRoleKey: config.serviceRoleKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Audit-specific client with a GET-only transport and an explicit table allowlist.
 * It exposes no write methods, SQL path, or RPC path.
 */
export class SupabasePriceCoverageReadClient implements PriceCoverageReadClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(
    config: PriceCoverageReadConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const validated = validateConfig(config);
    this.baseUrl = validated.url;
    this.serviceRoleKey = validated.serviceRoleKey;
  }

  async getRows(
    table: PriceCoverageAuditTable,
    query: Readonly<Record<string, string>>,
  ): Promise<readonly PriceCoverageAuditRow[]> {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error("Price coverage audit table is not allowlisted.");
    }
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
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Read-only GET public.${table} failed with HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.some((row) => !isRecord(row))) {
      throw new Error(`Supabase returned an invalid public.${table} audit response.`);
    }
    return body;
  }
}

export function createSupabasePriceCoverageReadClient(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): SupabasePriceCoverageReadClient {
  const url = environment.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL.");
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  return new SupabasePriceCoverageReadClient({ url, serviceRoleKey }, fetchImplementation);
}

async function readAllRows(
  client: PriceCoverageReadClient,
  table: PriceCoverageAuditTable,
  pageSize: number,
  maxRows: number,
): Promise<readonly PriceCoverageAuditRow[]> {
  const rows: PriceCoverageAuditRow[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const limit = Math.min(pageSize, maxRows - offset);
    const page = await client.getRows(table, {
      select: TABLE_SELECTS[table],
      order: "id.asc",
      limit: String(limit),
      offset: String(offset),
    });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
  throw new Error(
    `Read-only audit stopped at ${maxRows} rows for public.${table}; no partial report was produced.`,
  );
}

export async function readPriceCoverageAuditInput(
  client: PriceCoverageReadClient,
  options: {
    readonly pageSize?: number;
    readonly maxRowsPerTable?: number;
  } = {},
): Promise<PriceCoverageAuditInput> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new Error(`Audit page size must be an integer between 1 and ${DEFAULT_PAGE_SIZE}.`);
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < pageSize) {
    throw new Error("Audit maximum rows per table must be an integer at least as large as page size.");
  }
  const [products, stores, mappings, prices] = await Promise.all([
    readAllRows(client, "products", pageSize, maxRows),
    readAllRows(client, "stores", pageSize, maxRows),
    readAllRows(client, "external_product_mappings", pageSize, maxRows),
    readAllRows(client, "prices", pageSize, maxRows),
  ]);
  return { products, stores, mappings, prices };
}