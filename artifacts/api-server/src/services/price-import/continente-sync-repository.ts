import type {
  ContinenteCatalogProduct, ContinenteExternalProductMapping,
} from "./continente-types.js";

export interface SyncProduct extends ContinenteCatalogProduct {
  readonly sourceType: string | null;
  readonly externalId: string | null;
}
export interface OnlineStore { readonly id: string; readonly name: string }
export interface PriceRpcDetailedResult {
  readonly kind: "detailed";
  readonly price_id: string;
  readonly price_created: boolean;
  readonly price_changed: boolean;
  readonly history_created: boolean;
  readonly stale_observation: boolean;
}
export interface PriceRpcIdResult {
  readonly kind: "uuid";
  readonly price_id: string;
}
export type PriceRpcResult = PriceRpcDetailedResult | PriceRpcIdResult;
export type Row = Record<string, unknown>;
export interface ContinenteStoredOnlinePrice {
  readonly sku: string;
  readonly sourceReference: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly price: string;
  readonly productId: string;
}
export interface ContinenteDailyCheckpointRow {
  readonly source_type: "continente";
  readonly cursor_value: string | null;
  readonly last_attempt_at: string | null;
  readonly last_success_at: string | null;
  readonly last_error: string | null;
  readonly metadata: Row;
  readonly updated_at: string;
}
export const PRICE_RPC_FIELDS = [
  "p_product_id", "p_store_id", "p_price", "p_currency", "p_captured_at",
  "p_valid_from", "p_valid_until", "p_source_type", "p_external_id",
  "p_source_reference", "p_promotion",
] as const;

export interface ContinenteSyncRepository {
  readonly commitEnabled: boolean;
  preflight(): Promise<{ blockers: string[]; mappingsAvailable: boolean }>;
  loadCatalog(): Promise<SyncProduct[]>;
  findMappings(sku: string): Promise<ContinenteExternalProductMapping[]>;
  findSourceProducts(sku: string): Promise<SyncProduct[]>;
  findProduct(id: string): Promise<SyncProduct | null>;
  findOnlineStore(): Promise<OnlineStore | null>;
  createOnlineStore(): Promise<OnlineStore>;
  createNative(fields: Row): Promise<SyncProduct>;
  updateNative(id: string, fields: Row): Promise<void>;
  createMapping(fields: Row): Promise<boolean>;
  upsertPrice(args: Row): Promise<PriceRpcResult>;
}

const PRODUCT_COLUMNS = "id,name,brand,barcode,unit,active,source_type,external_id";
function record(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function amountText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    return Number(value).toFixed(2);
  }
  return null;
}
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DETAILED_PRICE_RESULT_FIELDS = [
  "price_id", "price_created", "price_changed", "history_created", "stale_observation",
] as const;

export function parsePriceRpcResult(value: unknown): PriceRpcResult {
  if (typeof value === "string" && UUID_PATTERN.test(value)) {
    return { kind: "uuid", price_id: value };
  }
  if (
    !record(value) ||
    typeof value.price_id !== "string" ||
    !UUID_PATTERN.test(value.price_id)
  ) {
    throw new Error("Invalid RPC result; price/history counts cannot be confirmed.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== DETAILED_PRICE_RESULT_FIELDS.length ||
    DETAILED_PRICE_RESULT_FIELDS.some((field) => !Object.hasOwn(value, field)) ||
    ["price_created", "price_changed", "history_created", "stale_observation"]
      .some((field) => typeof value[field] !== "boolean")
  ) {
    throw new Error("Invalid RPC result; price/history counts cannot be confirmed.");
  }
  return {
    kind: "detailed",
    price_id: value.price_id as string,
    price_created: value.price_created as boolean,
    price_changed: value.price_changed as boolean,
    history_created: value.history_created as boolean,
    stale_observation: value.stale_observation as boolean,
  };
}
function product(row: Row): SyncProduct {
  const id = text(row.id);
  const name = text(row.name);
  if (!id || !name || typeof row.active !== "boolean") throw new Error("Invalid catalog product.");
  return {
    id, name, active: row.active, brand: text(row.brand), barcode: text(row.barcode),
    unit: text(row.unit), sourceType: text(row.source_type), externalId: text(row.external_id),
  };
}
export class ContinenteDatabaseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Supabase request failed: HTTP ${status} (${code}).`);
  }
}
function isServiceRoleKey(key: string): boolean {
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString());
    return payload.role === "service_role";
  } catch { return false; }
}

/** Server-only REST transport. Never retries a mutation or exposes credentials/errors bodies. */
export class SupabaseContinenteSyncRepository implements ContinenteSyncRepository {
  private readonly base: URL;
  private readonly headers: Record<string, string>;
  constructor(
    readonly commitEnabled: boolean,
    environment: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = environment.SUPABASE_URL ?? environment.EXPO_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error("Missing SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL.");
    this.base = new URL(url);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password ||
        this.base.search || this.base.hash) throw new Error("Invalid Supabase HTTPS URL.");
    const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (serviceKey && !isServiceRoleKey(serviceKey)) throw new Error("Invalid server service-role credential.");
    if (commitEnabled && !serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
    const key = serviceKey ?? environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!key) throw new Error("Missing Supabase read credential.");
    this.headers = {
      apikey: key, Accept: "application/json", "Content-Type": "application/json",
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  private async request(
    path: string,
    method = "GET",
    body?: Row,
    query: Record<string, string> = {},
    prefer = "return=representation",
  ): Promise<unknown> {
    if (method !== "GET" && !this.commitEnabled) throw new Error("Dry run forbids mutations.");
    // Prices/history cannot be mutated directly even in commit mode.
    if (method !== "GET" && /^\/(?:prices|price_history)(?:\?|$)/.test(path)) {
      throw new Error("Prices must be written exclusively through the atomic RPC.");
    }
    const url = new URL(`/rest/v1${path}`, this.base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      method, headers: { ...this.headers, Prefer: prefer },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      throw new ContinenteDatabaseError(response.status, record(data) && typeof data.code === "string" ? data.code : "request_failed");
    }
    return data;
  }
  private async rows(table: string, query: Record<string, string>): Promise<Row[]> {
    const data = await this.request(`/${table}`, "GET", undefined, query);
    if (!Array.isArray(data) || data.some((row) => !record(row))) throw new Error(`Invalid ${table} response.`);
    return data as Row[];
  }
  async preflight(): Promise<{ blockers: string[]; mappingsAvailable: boolean }> {
    const response = await this.fetchImpl(new URL("/rest/v1/", this.base), {
      method: "GET", headers: { ...this.headers, Accept: "application/openapi+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { blockers: ["Cannot verify database/RPC schema with the available read credential."], mappingsAvailable: false };
    }
    const schema = await response.json() as { definitions?: Record<string, { properties?: Row; required?: string[] }>; paths?: Record<string, { post?: { parameters?: { in?: string; schema?: { properties?: Row } }[] } }> };
    const blockers: string[] = [];
    for (const table of ["products", "stores", "external_product_mappings", "prices", "price_history"]) {
      if (!schema.definitions?.[table]) blockers.push(`Missing public.${table}.`);
    }
    const requiredColumns: Record<string, string[]> = {
      products: ["source_type", "external_id", "image_url", "package_quantity", "package_unit", "unit"],
      stores: ["source_type", "external_id", "store_type"],
      external_product_mappings: ["source_type", "external_product_id", "product_id", "match_method", "confidence", "verified"],
    };
    for (const [table, columns] of Object.entries(requiredColumns)) {
      if (!schema.definitions?.[table]) continue;
      for (const column of columns) if (!schema.definitions[table]!.properties?.[column]) {
        blockers.push(`Missing ${table}.${column}.`);
      }
    }
    if (schema.definitions?.products?.required?.includes("unit")) {
      blockers.push("products.unit must allow NULL for genuinely unknown package formats.");
    }
    const rpc = schema.paths?.["/rpc/upsert_verified_price_with_history"]?.post;
    if (!rpc) blockers.push("Missing public.upsert_verified_price_with_history.");
    else {
      const properties = rpc.parameters?.find((parameter) => parameter.in === "body")?.schema?.properties;
      if (!properties || PRICE_RPC_FIELDS.some((field) => !Object.hasOwn(properties, field))) {
        blockers.push("The price RPC parameter contract does not match the supplied migration.");
      }
    }
    if (rpc && schema.definitions?.external_product_mappings) {
      if (!schema.paths?.["/rpc/continente_sync_capabilities"]) {
        blockers.push("Missing read-only Continente safety/index capability check.");
      } else {
        const capabilities = await this.request("/rpc/continente_sync_capabilities");
        if (!record(capabilities) || capabilities.product_identity_unique !== true ||
            capabilities.store_identity_unique !== true || capabilities.price_identity_unique !== true) {
          blockers.push("Continente unique identity indexes have not been confirmed.");
        }
      }
    }
    return { blockers, mappingsAvailable: Boolean(schema.definitions?.external_product_mappings) };
  }
  async preflightDailySync(): Promise<string[]> {
    const response = await this.fetchImpl(new URL("/rest/v1/", this.base), {
      method: "GET",
      headers: { ...this.headers, Accept: "application/openapi+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return ["Cannot verify the daily checkpoint schema."];
    const schema = await response.json() as {
      definitions?: Record<string, { properties?: Row }>;
    };
    const blockers: string[] = [];
    const state = schema.definitions?.source_sync_state;
    if (!state) blockers.push("Missing existing public.source_sync_state table.");
    for (const column of [
      "source_type", "cursor_value", "last_attempt_at", "last_success_at",
      "last_error", "metadata", "updated_at",
    ]) {
      if (state && !state.properties?.[column]) {
        blockers.push(`Missing source_sync_state.${column}.`);
      }
    }
    const prices = schema.definitions?.prices;
    for (const column of [
      "source_type", "external_id", "source_reference", "captured_at",
      "valid_until", "price", "product_id", "store_id",
    ]) {
      if (prices && !prices.properties?.[column]) blockers.push(`Missing prices.${column}.`);
    }
    return blockers;
  }
  async loadDailyCheckpoint(): Promise<ContinenteDailyCheckpointRow | null> {
    const rows = await this.rows("source_sync_state", {
      select: "source_type,cursor_value,last_attempt_at,last_success_at,last_error,metadata,updated_at",
      source_type: "eq.continente",
      limit: "2",
    });
    if (rows.length > 1) throw new Error("Multiple Continente sync checkpoints; refusing an arbitrary resume state.");
    if (!rows.length) return null;
    const row = rows[0]!;
    if (row.source_type !== "continente" || !record(row.metadata) || !text(row.updated_at)) {
      throw new Error("The Continente sync checkpoint has an invalid shape.");
    }
    return {
      source_type: "continente",
      cursor_value: text(row.cursor_value),
      last_attempt_at: text(row.last_attempt_at),
      last_success_at: text(row.last_success_at),
      last_error: text(row.last_error),
      metadata: row.metadata,
      updated_at: String(row.updated_at),
    };
  }
  async insertDailyCheckpoint(
    fields: Omit<ContinenteDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<ContinenteDailyCheckpointRow> {
    const now = new Date().toISOString();
    const result = await this.request("/source_sync_state", "POST", {
      ...fields,
      updated_at: fields.updated_at ?? now,
    });
    if (!Array.isArray(result) || result.length !== 1 || !record(result[0])) {
      throw new Error("Daily checkpoint insertion could not be confirmed.");
    }
    return this.parseDailyCheckpoint(result[0]);
  }
  async updateDailyCheckpoint(
    expectedUpdatedAt: string,
    fields: Omit<ContinenteDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<ContinenteDailyCheckpointRow> {
    const result = await this.request(
      "/source_sync_state",
      "PATCH",
      { ...fields, updated_at: fields.updated_at ?? new Date().toISOString() },
      { source_type: "eq.continente", updated_at: `eq.${expectedUpdatedAt}` },
    );
    if (!Array.isArray(result) || result.length !== 1 || !record(result[0])) {
      throw new Error("Daily checkpoint changed concurrently; refusing to overwrite it.");
    }
    return this.parseDailyCheckpoint(result[0]);
  }
  async loadOnlinePriceCandidates(storeId: string): Promise<ContinenteStoredOnlinePrice[]> {
    const result: ContinenteStoredOnlinePrice[] = [];
    for (let offset = 0; offset < 100_000; offset += 500) {
      const rows = await this.rows("prices", {
        select: "external_id,source_reference,captured_at,valid_until,price,product_id",
        source_type: "eq.continente",
        store_id: `eq.${storeId}`,
        order: "valid_until.asc.nullsfirst,captured_at.asc,external_id.asc",
        limit: "500",
        offset: String(offset),
      });
      for (const row of rows) {
        const externalId = text(row.external_id);
        if (!externalId?.startsWith("online:")) continue;
        const sku = externalId.slice("online:".length);
        const sourceReference = text(row.source_reference);
        const capturedAt = text(row.captured_at);
        const price = amountText(row.price);
        const productId = text(row.product_id);
        if (!/^[1-9]\d*$/.test(sku) || !sourceReference || !capturedAt || !price || !productId) {
          throw new Error("An online Continente price row has invalid refresh fields.");
        }
        result.push({
          sku,
          sourceReference,
          capturedAt,
          validUntil: text(row.valid_until),
          price,
          productId,
        });
      }
      if (rows.length < 500) return result;
    }
    throw new Error("Online price candidates exceeded their explicit scan bound.");
  }
  async loadOnlinePricesBySkus(
    storeId: string,
    skus: readonly string[],
  ): Promise<Map<string, ContinenteStoredOnlinePrice>> {
    const result = new Map<string, ContinenteStoredOnlinePrice>();
    for (const sku of new Set(skus)) {
      const rows = await this.rows("prices", {
        select: "external_id,source_reference,captured_at,valid_until,price,product_id",
        source_type: "eq.continente",
        store_id: `eq.${storeId}`,
        external_id: `eq.online:${sku}`,
        limit: "2",
      });
      if (rows.length > 1) throw new Error(`Multiple online price rows for Continente SKU ${sku}.`);
      if (!rows.length) continue;
      const row = rows[0]!;
      const sourceReference = text(row.source_reference);
      const capturedAt = text(row.captured_at);
      const price = amountText(row.price);
      const productId = text(row.product_id);
      if (!sourceReference || !capturedAt || !price || !productId) {
        throw new Error(`The existing online price for Continente SKU ${sku} is incomplete.`);
      }
      result.set(sku, {
        sku,
        sourceReference,
        capturedAt,
        validUntil: text(row.valid_until),
        price,
        productId,
      });
    }
    return result;
  }
  async loadHistoryKeys(
    storeId: string,
    productIds: readonly string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(productIds)];
    const history = new Set<string>();
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      if (chunk.some((id) => !UUID_PATTERN.test(id))) {
        throw new Error("Cannot verify history for an invalid product UUID.");
      }
      const rows = await this.rows("price_history", {
        select: "product_id,store_id,price,captured_at",
        product_id: `in.(${chunk.join(",")})`,
        store_id: `eq.${storeId}`,
        order: "captured_at.desc",
        limit: "10000",
      });
      for (const row of rows) {
        const productId = text(row.product_id);
        const price = amountText(row.price);
        const capturedAt = text(row.captured_at);
        if (productId && price && capturedAt && row.store_id === storeId) {
          history.add(`${productId}|${price}|${Date.parse(capturedAt)}`);
        }
      }
    }
    return history;
  }
  async loadCatalog(): Promise<SyncProduct[]> {
    const catalog: SyncProduct[] = [];
    for (let offset = 0; offset < 100_000; offset += 500) {
      const rows = await this.rows("products", { select: PRODUCT_COLUMNS, active: "eq.true", order: "id.asc", limit: "500", offset: String(offset) });
      catalog.push(...rows.map(product));
      if (rows.length < 500) return catalog;
    }
    throw new Error("Catalog exceeded its explicit safety bound; no partial matching allowed.");
  }
  async findMappings(sku: string): Promise<ContinenteExternalProductMapping[]> {
    const rows = await this.rows("external_product_mappings", { select: "source_type,external_product_id,product_id,match_method,confidence,verified", source_type: "eq.continente", external_product_id: `eq.${sku}`, limit: "2" });
    return rows.map((row) => {
      if (!text(row.product_id) || !text(row.match_method) || typeof row.verified !== "boolean" ||
          !Number.isFinite(Number(row.confidence))) throw new Error("Invalid external mapping.");
      return { sourceType: String(row.source_type), externalProductId: String(row.external_product_id), productId: String(row.product_id), matchMethod: String(row.match_method), confidence: Number(row.confidence), verified: row.verified };
    });
  }
  async findSourceProducts(sku: string): Promise<SyncProduct[]> {
    return (await this.rows("products", { select: PRODUCT_COLUMNS, source_type: "eq.continente", external_id: `eq.${sku}`, limit: "2" })).map(product);
  }
  async findProduct(id: string): Promise<SyncProduct | null> {
    const rows = await this.rows("products", { select: PRODUCT_COLUMNS, id: `eq.${id}`, limit: "2" });
    if (rows.length > 1) throw new Error("Non-unique product ID.");
    return rows[0] ? product(rows[0]) : null;
  }
  async findOnlineStore(): Promise<OnlineStore | null> {
    const rows = await this.rows("stores", { select: "id,name,active,store_type,district,municipality,parish,latitude,longitude", source_type: "eq.continente", external_id: "eq.online", limit: "2" });
    if (rows.length > 1) throw new Error("Multiple Continente Online stores; refusing arbitrary selection.");
    if (!rows.length) return null;
    const row = rows[0]!;
    if (!text(row.id) || row.name !== "Continente Online" || row.active !== true ||
        row.store_type !== "online" ||
        ["district", "municipality", "parish", "latitude", "longitude"].some((field) => row[field] !== null)) {
      throw new Error("The online store must be active, named Continente Online, and have no physical location.");
    }
    return { id: String(row.id), name: "Continente Online" };
  }
  async createOnlineStore(): Promise<OnlineStore> {
    const existing = await this.findOnlineStore();
    if (existing) return existing;
    try {
      await this.request("/stores", "POST", { name: "Continente Online", store_type: "online", source_type: "continente", external_id: "online", active: true, district: null, municipality: null, parish: null, latitude: null, longitude: null, address: null, website: "https://www.continente.pt" });
    } catch (error) {
      if (!(error instanceof ContinenteDatabaseError) || error.status !== 409) throw error;
    }
    const created = await this.findOnlineStore();
    if (!created) throw new Error("Online store insertion could not be confirmed.");
    return created;
  }
  async createNative(fields: Row): Promise<SyncProduct> {
    const result = await this.request("/products", "POST", fields);
    if (!Array.isArray(result) || result.length !== 1 || !record(result[0])) throw new Error("Product insertion could not be confirmed.");
    return product(result[0]);
  }
  async updateNative(id: string, fields: Row): Promise<void> {
    const result = await this.request("/products", "PATCH", fields, { id: `eq.${id}`, source_type: "eq.continente" });
    if (!Array.isArray(result) || result.length !== 1) throw new Error("Source-native update could not be confirmed.");
  }
  async createMapping(fields: Row): Promise<boolean> {
    try {
      const rows = await this.request("/external_product_mappings", "POST", fields);
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Mapping insertion could not be confirmed.");
      return true;
    } catch (error) {
      if (!(error instanceof ContinenteDatabaseError) || error.status !== 409) throw error;
      const mappings = await this.findMappings(String(fields.external_product_id));
      if (mappings.length !== 1 || mappings[0]!.productId !== fields.product_id || !mappings[0]!.verified) throw new Error("Mapping conflict; refusing to overwrite a different association.");
      return false;
    }
  }
  async upsertPrice(args: Row): Promise<PriceRpcResult> {
    const result = await this.request("/rpc/upsert_verified_price_with_history", "POST", args);
    return parsePriceRpcResult(result);
  }
  private parseDailyCheckpoint(row: Row): ContinenteDailyCheckpointRow {
    if (row.source_type !== "continente" || !record(row.metadata) || !text(row.updated_at)) {
      throw new Error("The saved Continente sync checkpoint has an invalid shape.");
    }
    return {
      source_type: "continente",
      cursor_value: text(row.cursor_value),
      last_attempt_at: text(row.last_attempt_at),
      last_success_at: text(row.last_success_at),
      last_error: text(row.last_error),
      metadata: row.metadata,
      updated_at: String(row.updated_at),
    };
  }
}