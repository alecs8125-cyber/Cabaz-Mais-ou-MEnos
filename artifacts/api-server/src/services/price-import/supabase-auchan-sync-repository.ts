import type {
  ContinenteExternalProductMapping,
  ContinenteCatalogProduct,
} from "./continente-types.js";
import {
  createSupabaseAuchanReadClient,
  SupabaseAuchanReadClient,
} from "./supabase-auchan-read.js";
import { resolveServerSupabaseUrl } from "./server-supabase-env.js";

type Row = Record<string, unknown>;

export interface AuchanReferenceStore {
  readonly id: string;
  readonly name: string;
}

export interface AuchanPreflight {
  readonly blockers: readonly string[];
  readonly referenceStore: AuchanReferenceStore | null;
  readonly mappingsAvailable: boolean;
  readonly capabilities: Readonly<{
    productIdentityUnique: boolean;
    storeIdentityUnique: boolean;
    priceIdentityUnique: boolean;
    referenceStoreExists: boolean;
  }>;
}

export interface AuchanStoredPrice {
  readonly id: string;
  readonly productId: string;
  readonly storeId: string;
  readonly price: string;
  readonly currency: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly verificationStatus: string;
}

export interface AuchanRefreshPriceCandidate {
  readonly sku: string;
  readonly sourceReference: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly price: string;
  readonly productId: string;
}

export interface AuchanDailyCheckpointRow {
  readonly source_type: "auchan";
  readonly cursor_value: string | null;
  readonly last_attempt_at: string | null;
  readonly last_success_at: string | null;
  readonly last_error: string | null;
  readonly metadata: Row;
  readonly updated_at: string;
}

export interface AuchanProductWrite {
  readonly product: ContinenteCatalogProduct;
  /** False when a GET reconciled an ambiguous/duplicate acknowledgement. */
  readonly inserted: boolean;
}

const PRODUCT_COLUMNS = "id,name,brand,barcode,unit,active,source_type,external_id";
const AUCHAN_REFERENCE_EXTERNAL_ID = "reference:2650-435";
const AUCHAN_PRICE_EXTERNAL_ID_PREFIX = `${AUCHAN_REFERENCE_EXTERNAL_ID}:`;
const AUCHAN_PRICE_RPC = "upsert_auchan_reference_price_with_history";
const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  products: [
    "id", "name", "brand", "barcode", "unit", "active", "source_type",
    "external_id", "image_url", "category", "package_quantity", "package_unit",
  ],
  stores: [
    "id", "name", "active", "store_type", "source_type", "external_id",
    "district", "municipality", "postal_code", "chain_name",
  ],
  external_product_mappings: [
    "source_type", "external_product_id", "product_id", "match_method",
    "confidence", "verified",
  ],
  prices: [
    "id", "product_id", "store_id", "price", "currency", "promotion",
    "valid_from", "captured_at", "valid_until", "source_type",
    "source_reference", "verification_status", "external_id",
  ],
  price_history: ["product_id", "store_id", "price", "captured_at"],
};
const REQUIRED_PRICE_RPC_ARGUMENTS = [
  "p_product_id",
  "p_price",
  "p_promotion",
  "p_captured_at",
  "p_source_reference",
  "p_external_product_id",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Row {
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

function readProduct(row: Row): ContinenteCatalogProduct {
  const id = text(row.id);
  const name = text(row.name);
  if (!id || !name || typeof row.active !== "boolean") {
    throw new Error("The Auchan sync read returned an invalid product.");
  }
  for (const field of ["brand", "barcode", "unit", "source_type", "external_id"]) {
    if (row[field] !== null && typeof row[field] !== "string") {
      throw new Error(`The Auchan sync read returned an invalid product ${field}.`);
    }
  }
  return {
    id,
    name,
    brand: text(row.brand),
    barcode: text(row.barcode),
    unit: text(row.unit),
    active: row.active,
    sourceType: text(row.source_type),
    externalId: text(row.external_id),
  };
}

export class AuchanDatabaseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Supabase Auchan request failed: HTTP ${status} (${code}).`);
  }
}

function isServiceRoleKey(key: string): boolean {
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const payload = JSON.parse(
      Buffer.from(key.split(".")[1] ?? "", "base64url").toString(),
    ) as Row;
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function rpcArgumentMatches(
  properties: Row,
  name: string,
  type: string,
  format: string,
): boolean {
  const property = properties[name];
  return isRecord(property) && property.type === type && property.format === format;
}

/** Server-side Auchan writer; the read client remains GET-only. */
export class SupabaseAuchanSyncRepository {
  private readonly baseUrl: URL;
  private readonly headers: Record<string, string>;
  private readonly readClient: SupabaseAuchanReadClient;
  private preflightPromise: Promise<AuchanPreflight> | null = null;

  constructor(
    readonly commitEnabled: boolean,
    environment: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const rawUrl = resolveServerSupabaseUrl(environment);
    this.baseUrl = new URL(rawUrl);
    if (
      this.baseUrl.protocol !== "https:" ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new Error("Auchan sync requires a valid Supabase HTTPS URL.");
    }
    const key = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (key && !isServiceRoleKey(key)) {
      throw new Error("Invalid server service-role credential.");
    }
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for Auchan sync.");
    this.readClient = createSupabaseAuchanReadClient(environment, fetchImpl);
    this.headers = {
      apikey: key,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  preflight(): Promise<AuchanPreflight> {
    this.preflightPromise ??= this.runPreflight();
    return this.preflightPromise;
  }

  async preflightDailySync(): Promise<string[]> {
    const schema = await this.readClient.getOpenApiSchema();
    const definitions = isRecord(schema.definitions) ? schema.definitions : {};
    const paths = isRecord(schema.paths) ? schema.paths : {};
    const blockers: string[] = [];
    const checkpoint = definitions.source_sync_state;
    if (!isRecord(checkpoint) || !isRecord(checkpoint.properties)) {
      blockers.push("Missing existing public.source_sync_state table for Auchan checkpointing.");
    } else {
      for (const column of [
        "source_type", "cursor_value", "last_attempt_at", "last_success_at",
        "last_error", "metadata", "updated_at",
      ]) {
        if (!Object.hasOwn(checkpoint.properties, column)) {
          blockers.push(`Missing source_sync_state.${column}.`);
        }
      }
    }
    const checkpointPath = paths["/source_sync_state"];
    if (
      !isRecord(checkpointPath) ||
      !isRecord(checkpointPath.get) ||
      !isRecord(checkpointPath.post) ||
      !isRecord(checkpointPath.patch)
    ) blockers.push("The existing source_sync_state GET/POST/PATCH contract is unavailable.");
    const prices = definitions.prices;
    if (!isRecord(prices) || !isRecord(prices.properties)) {
      blockers.push("Missing public.prices for Auchan refresh ordering.");
    } else {
      for (const column of [
        "source_type", "external_id", "source_reference", "captured_at",
        "valid_until", "price", "product_id", "store_id",
      ]) {
        if (!Object.hasOwn(prices.properties, column)) blockers.push(`Missing prices.${column}.`);
      }
    }
    return blockers;
  }

  private async runPreflight(): Promise<AuchanPreflight> {
    const blockers: string[] = [];
    const schema = await this.readClient.getOpenApiSchema();
    const definitions = isRecord(schema.definitions) ? schema.definitions : {};
    const paths = isRecord(schema.paths) ? schema.paths : {};

    for (const [table, columns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const definition = definitions[table];
      const properties = isRecord(definition) && isRecord(definition.properties)
        ? definition.properties
        : null;
      if (!properties) {
        blockers.push(`Missing public.${table}.`);
        continue;
      }
      for (const column of columns) {
        if (!Object.hasOwn(properties, column)) blockers.push(`Missing ${table}.${column}.`);
      }
    }
    const productDefinition = definitions.products;
    if (isRecord(productDefinition) && Array.isArray(productDefinition.required) &&
        productDefinition.required.includes("unit")) {
      blockers.push("products.unit must allow NULL for unknown Auchan package formats.");
    }

    const rpcDefinition = paths[`/rpc/${AUCHAN_PRICE_RPC}`];
    const rpcPost = isRecord(rpcDefinition) && isRecord(rpcDefinition.post)
      ? rpcDefinition.post
      : null;
    const parameters = rpcPost && Array.isArray(rpcPost.parameters)
      ? rpcPost.parameters
      : [];
    const body = parameters.find((parameter) =>
      isRecord(parameter) && parameter.in === "body"
    );
    const properties = isRecord(body) && isRecord(body.schema) &&
        isRecord(body.schema.properties)
      ? body.schema.properties
      : null;
    const required = isRecord(body) && isRecord(body.schema) &&
        Array.isArray(body.schema.required)
      ? body.schema.required
      : [];
    const rpcContractValid = Boolean(
      properties &&
      REQUIRED_PRICE_RPC_ARGUMENTS.every((argument) => required.includes(argument)) &&
      rpcArgumentMatches(properties, "p_product_id", "string", "uuid") &&
      rpcArgumentMatches(properties, "p_price", "number", "numeric") &&
      rpcArgumentMatches(properties, "p_promotion", "boolean", "boolean") &&
      rpcArgumentMatches(properties, "p_captured_at", "string", "timestamp with time zone") &&
      rpcArgumentMatches(properties, "p_source_reference", "string", "text") &&
      rpcArgumentMatches(properties, "p_external_product_id", "string", "text"),
    );
    if (!rpcContractValid) blockers.push(`Missing or changed public.${AUCHAN_PRICE_RPC} contract.`);

    const capabilityDefinition = paths["/rpc/auchan_sync_capabilities"];
    const hasCapabilityGet = isRecord(capabilityDefinition) &&
      isRecord(capabilityDefinition.get);
    if (!hasCapabilityGet) blockers.push("Missing GET public.auchan_sync_capabilities.");

    let capabilities = {
      productIdentityUnique: false,
      storeIdentityUnique: false,
      priceIdentityUnique: false,
      referenceStoreExists: false,
    };
    if (hasCapabilityGet) {
      const raw = await this.readClient.getRpc("auchan_sync_capabilities");
      if (!isRecord(raw)) {
        blockers.push("Auchan capability GET returned an invalid response.");
      } else {
        capabilities = {
          productIdentityUnique: raw.product_identity_unique === true,
          storeIdentityUnique: raw.store_identity_unique === true,
          priceIdentityUnique: raw.price_identity_unique === true,
          referenceStoreExists: raw.reference_store_exists === true,
        };
        if (!capabilities.productIdentityUnique) blockers.push("Auchan product identity uniqueness is not confirmed.");
        if (!capabilities.storeIdentityUnique) blockers.push("Auchan reference-store uniqueness is not confirmed.");
        if (!capabilities.priceIdentityUnique) blockers.push("Auchan price identity uniqueness is not confirmed.");
        if (!capabilities.referenceStoreExists) blockers.push("Auchan reference store is not confirmed by the capability GET.");
      }
    }

    let referenceStore: AuchanReferenceStore | null = null;
    if (Object.hasOwn(definitions, "stores")) {
      try {
        referenceStore = await this.findReferenceStore();
        if (!referenceStore) blockers.push("The active Auchan reference store 2650-435 is missing.");
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : "The Auchan reference store could not be verified.");
      }
    }
    return {
      blockers,
      referenceStore,
      mappingsAvailable: Object.hasOwn(definitions, "external_product_mappings"),
      capabilities,
    };
  }

  private async rows(
    table:
      | "products"
      | "stores"
      | "external_product_mappings"
      | "prices"
      | "price_history"
      | "source_sync_state",
    query: Readonly<Record<string, string>>,
  ): Promise<readonly Row[]> {
    return this.readClient.getRows(table, query);
  }

  async loadDailyCheckpoint(): Promise<AuchanDailyCheckpointRow | null> {
    const rows = await this.rows("source_sync_state", {
      select: "source_type,cursor_value,last_attempt_at,last_success_at,last_error,metadata,updated_at",
      source_type: "eq.auchan",
      limit: "2",
    });
    if (rows.length > 1) {
      throw new Error("Multiple Auchan sync checkpoints; refusing an arbitrary resume state.");
    }
    return rows.length ? this.parseDailyCheckpoint(rows[0]!) : null;
  }

  async insertDailyCheckpoint(
    fields: Omit<AuchanDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<AuchanDailyCheckpointRow> {
    if (fields.source_type !== "auchan" || !isRecord(fields.metadata)) {
      throw new Error("Only a valid source_type=auchan checkpoint may be inserted.");
    }
    const result = await this.mutateCheckpoint(
      "POST",
      { ...fields, updated_at: fields.updated_at ?? new Date().toISOString() },
    );
    if (!Array.isArray(result) || result.length !== 1 || !isRecord(result[0])) {
      throw new Error("Auchan daily checkpoint insertion could not be confirmed.");
    }
    return this.parseDailyCheckpoint(result[0]);
  }

  async updateDailyCheckpoint(
    expectedUpdatedAt: string,
    fields: Omit<AuchanDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<AuchanDailyCheckpointRow> {
    if (fields.source_type !== "auchan" || !isRecord(fields.metadata)) {
      throw new Error("Only a valid source_type=auchan checkpoint may be updated.");
    }
    const result = await this.mutateCheckpoint(
      "PATCH",
      { ...fields, updated_at: fields.updated_at ?? new Date().toISOString() },
      { source_type: "eq.auchan", updated_at: `eq.${expectedUpdatedAt}` },
    );
    if (!Array.isArray(result) || result.length !== 1 || !isRecord(result[0])) {
      throw new Error("Auchan checkpoint changed concurrently; refusing to overwrite it.");
    }
    return this.parseDailyCheckpoint(result[0]);
  }

  async loadDailyPriceCandidates(storeId: string): Promise<AuchanRefreshPriceCandidate[]> {
    const result: AuchanRefreshPriceCandidate[] = [];
    for (let offset = 0; offset < 100_000; offset += 500) {
      const rows = await this.rows("prices", {
        select: "external_id,source_reference,captured_at,valid_until,price,product_id",
        source_type: "eq.auchan",
        store_id: `eq.${storeId}`,
        order: "valid_until.asc.nullsfirst,captured_at.asc,external_id.asc",
        limit: "500",
        offset: String(offset),
      });
      for (const row of rows) {
        const scopedExternalId = text(row.external_id);
        const sku = scopedExternalId?.startsWith(AUCHAN_PRICE_EXTERNAL_ID_PREFIX)
          ? scopedExternalId.slice(AUCHAN_PRICE_EXTERNAL_ID_PREFIX.length)
          : null;
        const sourceReference = text(row.source_reference);
        const capturedAt = text(row.captured_at);
        const price = amountText(row.price);
        const productId = text(row.product_id);
        if (
          !sku || !/^[1-9]\d*$/.test(sku) || !sourceReference ||
          !capturedAt || !price || !productId
        ) throw new Error("An Auchan reference price row has invalid refresh fields.");
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
    throw new Error("Auchan price candidates exceeded their explicit scan bound.");
  }

  async findReferenceStore(): Promise<AuchanReferenceStore | null> {
    const rows = await this.rows("stores", {
      select: "id,name,active,store_type,source_type,external_id,district,municipality,postal_code,chain_name",
      source_type: "eq.auchan",
      external_id: `eq.${AUCHAN_REFERENCE_EXTERNAL_ID}`,
      limit: "2",
    });
    if (rows.length > 1) throw new Error("Multiple Auchan 2650-435 reference stores; refusing an arbitrary store.");
    if (!rows.length) return null;
    const row = rows[0]!;
    if (
      !text(row.id) ||
      row.active !== true ||
      row.source_type !== "auchan" ||
      row.external_id !== AUCHAN_REFERENCE_EXTERNAL_ID ||
      row.store_type !== "online_reference" ||
      row.postal_code !== "2650-435" ||
      row.district !== "Lisboa" ||
      row.municipality !== "Amadora" ||
      row.chain_name !== "Auchan" ||
      !text(row.name)
    ) {
      throw new Error("The Auchan reference store identity or Amadora scope is invalid.");
    }
    return { id: String(row.id), name: String(row.name) };
  }

  async loadActiveProducts(): Promise<ContinenteCatalogProduct[]> {
    const products: ContinenteCatalogProduct[] = [];
    for (let offset = 0; offset < 10_000; offset += 500) {
      const rows = await this.rows("products", {
        select: PRODUCT_COLUMNS,
        active: "eq.true",
        order: "id.asc",
        limit: "500",
        offset: String(offset),
      });
      products.push(...rows.map(readProduct));
      if (rows.length < 500) return products;
    }
    throw new Error("The active product catalog exceeded its explicit 10,000-row limit.");
  }

  async findMappings(externalProductId: string): Promise<ContinenteExternalProductMapping[]> {
    const rows = await this.rows("external_product_mappings", {
      select: "source_type,external_product_id,product_id,match_method,confidence,verified",
      source_type: "eq.auchan",
      external_product_id: `eq.${externalProductId}`,
      limit: "2",
    });
    return rows.map((row) => {
      const sourceType = text(row.source_type);
      const externalId = text(row.external_product_id);
      const productId = text(row.product_id);
      const matchMethod = text(row.match_method);
      const confidence = Number(row.confidence);
      if (
        !sourceType || !externalId || !productId || !matchMethod ||
        typeof row.verified !== "boolean" ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      ) throw new Error("The persisted Auchan product mapping is invalid.");
      return {
        sourceType,
        externalProductId: externalId,
        productId,
        matchMethod,
        confidence,
        verified: row.verified,
      };
    });
  }

  async findSourceProducts(externalProductId: string): Promise<ContinenteCatalogProduct[]> {
    const rows = await this.rows("products", {
      select: PRODUCT_COLUMNS,
      source_type: "eq.auchan",
      external_id: `eq.${externalProductId}`,
      limit: "2",
    });
    return rows.map(readProduct);
  }

  async findProduct(id: string): Promise<ContinenteCatalogProduct | null> {
    const rows = await this.rows("products", {
      select: PRODUCT_COLUMNS,
      id: `eq.${id}`,
      limit: "2",
    });
    if (rows.length > 1) throw new Error("A product ID is not unique.");
    return rows[0] ? readProduct(rows[0]) : null;
  }

  private async mutate(path: string, body: Row): Promise<unknown> {
    if (!this.commitEnabled) throw new Error("Auchan dry-run forbids database mutations.");
    if (
      path !== "/products" &&
      path !== "/external_product_mappings" &&
      path !== `/rpc/${AUCHAN_PRICE_RPC}`
    ) throw new Error("The requested Auchan mutation is not allowlisted.");
    const url = new URL(`/rest/v1${path}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...this.headers, Prefer: "return=representation" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw cause;
    }
    let data: unknown = null;
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch {
        if (response.ok) throw new Error("Mutation acknowledgement was not valid JSON.");
      }
    }
    if (!response.ok) {
      const code = isRecord(data) && typeof data.code === "string"
        ? data.code
        : "request_failed";
      throw new AuchanDatabaseError(response.status, code);
    }
    return data;
  }

  private async mutateCheckpoint(
    method: "POST" | "PATCH",
    body: Row,
    query: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    if (!this.commitEnabled) throw new Error("Auchan dry-run forbids database mutations.");
    if (body.source_type !== "auchan") {
      throw new Error("Checkpoint writes are restricted to source_type=auchan.");
    }
    const url = new URL("/rest/v1/source_sync_state", this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { ...this.headers, Prefer: "return=representation" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw cause;
    }
    let data: unknown = null;
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch {
        if (response.ok) throw new Error("Checkpoint acknowledgement was not valid JSON.");
      }
    }
    if (!response.ok) {
      const code = isRecord(data) && typeof data.code === "string"
        ? data.code
        : "request_failed";
      throw new AuchanDatabaseError(response.status, code);
    }
    return data;
  }

  async createNative(fields: Row): Promise<AuchanProductWrite> {
    if (!this.commitEnabled) throw new Error("Auchan dry-run forbids database mutations.");
    const externalId = text(fields.external_id);
    if (fields.source_type !== "auchan" || !externalId) {
      throw new Error("Only source-native Auchan products may be created.");
    }
    try {
      const result = await this.mutate("/products", fields);
      if (Array.isArray(result) && result.length === 1 && isRecord(result[0])) {
        return { product: readProduct(result[0]), inserted: true };
      }
    } catch (cause) {
      const raced = await this.findSourceProducts(externalId);
      if (raced.length === 1 && raced[0]!.active) {
        return { product: raced[0]!, inserted: false };
      }
      throw cause;
    }
    const reconciled = await this.findSourceProducts(externalId);
    if (reconciled.length === 1 && reconciled[0]!.active) {
      return { product: reconciled[0]!, inserted: false };
    }
    throw new Error("Auchan product insertion could not be confirmed; no retry was attempted.");
  }

  async createMapping(fields: Row): Promise<boolean> {
    if (!this.commitEnabled) throw new Error("Auchan dry-run forbids database mutations.");
    if (
      fields.source_type !== "auchan" ||
      typeof fields.external_product_id !== "string" ||
      typeof fields.product_id !== "string" ||
      fields.verified !== true
    ) throw new Error("Only verified Auchan mappings may be created.");
    const reconcile = async () => {
      const rows = await this.findMappings(fields.external_product_id as string);
      if (
        rows.length !== 1 ||
        rows[0]!.productId !== fields.product_id ||
        !rows[0]!.verified ||
        rows[0]!.sourceType !== "auchan"
      ) throw new Error("Mapping insertion could not be reconciled to the requested product.");
      return rows[0]!;
    };
    try {
      const result = await this.mutate("/external_product_mappings", fields);
      if (Array.isArray(result) && result.length === 1 && isRecord(result[0])) {
        await reconcile();
        return true;
      }
    } catch (cause) {
      try {
        await reconcile();
        return false;
      } catch {
        throw cause;
      }
    }
    await reconcile();
    return false;
  }

  async upsertReferencePrice(args: Row): Promise<unknown> {
    return this.mutate(`/rpc/${AUCHAN_PRICE_RPC}`, args);
  }

  async findLatestReferencePrice(
    productId: string,
    storeId: string,
    externalProductId: string,
  ): Promise<AuchanStoredPrice | null> {
    const rows = await this.rows("prices", {
      select: "id,product_id,store_id,price,currency,captured_at,valid_until,source_type,source_reference,verification_status",
      source_type: "eq.auchan",
      product_id: `eq.${productId}`,
      store_id: `eq.${storeId}`,
      external_id: `eq.${AUCHAN_PRICE_EXTERNAL_ID_PREFIX}${externalProductId}`,
      order: "captured_at.desc",
      limit: "2",
    });
    if (rows.length > 1) {
      throw new Error("Multiple Auchan prices exist for one product/store/external identity.");
    }
    return rows.length ? this.parseStoredPrice(rows[0]!) : null;
  }

  async findReferencePrice(
    productId: string,
    storeId: string,
    sourceReference: string,
    capturedAt: string,
  ): Promise<AuchanStoredPrice | null> {
    const rows = await this.rows("prices", {
      select: "id,product_id,store_id,price,currency,captured_at,valid_until,source_type,source_reference,verification_status",
      source_type: "eq.auchan",
      product_id: `eq.${productId}`,
      store_id: `eq.${storeId}`,
      source_reference: `eq.${sourceReference}`,
      captured_at: `eq.${capturedAt}`,
      limit: "2",
    });
    if (rows.length > 1) throw new Error("Multiple Auchan prices match one captured reference observation.");
    if (!rows.length) return null;
    return this.parseStoredPrice(rows[0]!);
  }

  private parseStoredPrice(row: Row): AuchanStoredPrice {
    const id = text(row.id);
    const returnedProductId = text(row.product_id);
    const returnedStoreId = text(row.store_id);
    const price = amountText(row.price);
    const currency = text(row.currency);
    const returnedCapturedAt = text(row.captured_at);
    const returnedSourceType = text(row.source_type);
    const returnedReference = text(row.source_reference);
    const verificationStatus = text(row.verification_status);
    if (
      !id || !returnedProductId || !returnedStoreId || !price || !currency ||
      !returnedCapturedAt || !returnedSourceType || !returnedReference ||
      !verificationStatus
    ) throw new Error("The persisted Auchan price row is incomplete.");
    return {
      id,
      productId: returnedProductId,
      storeId: returnedStoreId,
      price,
      currency,
      capturedAt: returnedCapturedAt,
      validUntil: text(row.valid_until),
      sourceType: returnedSourceType,
      sourceReference: returnedReference,
      verificationStatus,
    };
  }

  async hasReferencePriceHistory(
    productId: string,
    storeId: string,
    price: string,
    capturedAt: string,
  ): Promise<boolean> {
    const rows = await this.rows("price_history", {
      select: "product_id,store_id,price,captured_at",
      product_id: `eq.${productId}`,
      store_id: `eq.${storeId}`,
      limit: "100",
    });
    return rows.some((row) =>
      row.product_id === productId &&
      row.store_id === storeId &&
      amountText(row.price) === amountText(price) &&
      typeof row.captured_at === "string" &&
      Number.isFinite(Date.parse(row.captured_at)) &&
      Date.parse(row.captured_at) === Date.parse(capturedAt)
    );
  }

  private parseDailyCheckpoint(row: Row): AuchanDailyCheckpointRow {
    const updatedAt = text(row.updated_at);
    if (
      row.source_type !== "auchan" ||
      !isRecord(row.metadata) ||
      !updatedAt ||
      !Number.isFinite(Date.parse(updatedAt))
    ) throw new Error("The saved Auchan daily checkpoint has an invalid shape.");
    return {
      source_type: "auchan",
      cursor_value: text(row.cursor_value),
      last_attempt_at: text(row.last_attempt_at),
      last_success_at: text(row.last_success_at),
      last_error: text(row.last_error),
      metadata: row.metadata,
      updated_at: updatedAt,
    };
  }
}