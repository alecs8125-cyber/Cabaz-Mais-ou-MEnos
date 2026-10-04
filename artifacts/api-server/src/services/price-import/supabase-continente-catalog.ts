import type {
  ContinenteCatalogProduct,
  ContinenteMappingRepository,
} from "./continente-types.js";
import type { SupabaseReadOnlyClient } from "./supabase-read.js";

const PAGE_SIZE = 500;
const MAX_ACTIVE_PRODUCTS = 10_000;
const PRODUCT_COLUMNS = "id,name,brand,barcode,unit,active,source_type,external_id";

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`public.products.${field} was not a string or null.`);
}

function optionalNullableText(value: unknown, field: string): string | null {
  return value === undefined ? null : nullableText(value, field);
}

function readCatalogProduct(row: Record<string, unknown>): ContinenteCatalogProduct {
  if (
    typeof row.id !== "string" || !row.id.trim() ||
    typeof row.name !== "string" || !row.name.trim() ||
    typeof row.active !== "boolean"
  ) {
    throw new Error("public.products returned an invalid row for Continente matching.");
  }
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    brand: nullableText(row.brand, "brand"),
    barcode: nullableText(row.barcode, "barcode"),
    unit: nullableText(row.unit, "unit"),
    active: row.active,
    sourceType: optionalNullableText(row.source_type, "source_type"),
    externalId: optionalNullableText(row.external_id, "external_id"),
  };
}

/** Loads only existing product fields through the GET-only Supabase REST client. */
export class SupabaseContinenteProductCatalog {
  constructor(private readonly client: SupabaseReadOnlyClient) {}

  async loadActiveProducts(): Promise<ContinenteCatalogProduct[]> {
    return this.loadProducts(true);
  }

  async loadAllProducts(): Promise<ContinenteCatalogProduct[]> {
    return this.loadProducts(false);
  }

  private async loadProducts(activeOnly: boolean): Promise<ContinenteCatalogProduct[]> {
    const products: ContinenteCatalogProduct[] = [];
    for (let offset = 0; offset < MAX_ACTIVE_PRODUCTS; offset += PAGE_SIZE) {
      const query: Record<string, string> = {
        select: PRODUCT_COLUMNS,
        order: "id.asc",
        limit: String(PAGE_SIZE),
        offset: String(offset),
      };
      if (activeOnly) query.active = "eq.true";
      const rows = await this.client.getRows("products", query);
      const page = rows
        .map(readCatalogProduct)
        .filter((product) => !activeOnly || product.active);
      products.push(...page);
      if (rows.length < PAGE_SIZE) return products;
    }
    throw new Error(
      `The active product catalog reached the ${MAX_ACTIVE_PRODUCTS}-row dry-run safety limit.`,
    );
  }
}

/**
 * No external-product-mapping table exists yet. This read-only empty repository
 * keeps the matcher contract ready without probing a missing table or writing data.
 */
export class NoPersistedContinenteMappings implements ContinenteMappingRepository {
  async findMappings(): Promise<readonly []> {
    return [];
  }
}