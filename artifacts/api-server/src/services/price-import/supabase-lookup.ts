import {
  normalizeBarcode,
  normalizeExternalStoreId,
  normalizeSourceType,
} from "./normalize.js";
import type {
  PriceImportLookup,
  ProductLookupCandidate,
  StoreMappingCandidate,
} from "./types.js";
import type { SupabaseReadOnlyClient } from "./supabase-read.js";

const SAMPLE_LOOKUP_LIMIT = "100";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProductCandidate(value: unknown): ProductLookupCandidate {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.barcode !== "string" ||
    typeof value.active !== "boolean"
  ) {
    throw new Error("O Supabase devolveu um produto com campos inválidos.");
  }

  return {
    id: value.id,
    barcode: value.barcode,
    active: value.active,
  };
}

function readStoreCandidate(value: unknown): StoreMappingCandidate {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.source_type !== "string" ||
    typeof value.external_id !== "string" ||
    typeof value.active !== "boolean"
  ) {
    throw new Error(
      "public.stores.source_type e external_id têm de ser texto para resolver a loja.",
    );
  }

  return {
    storeId: value.id,
    sourceType: value.source_type,
    externalStoreId: value.external_id,
    active: value.active,
  };
}

function postgrestExact(value: string): string {
  return `eq.${value}`;
}

export class SupabasePriceImportLookup implements PriceImportLookup {
  constructor(private readonly client: SupabaseReadOnlyClient) {}

  async findActiveProductsByExactBarcode(
    inputBarcode: string,
  ): Promise<readonly ProductLookupCandidate[]> {
    const barcode = normalizeBarcode(inputBarcode);
    if (!barcode) return [];

    const rows = await this.client.getRows("products", {
      select: "id,barcode,active",
      active: "eq.true",
      barcode: postgrestExact(barcode),
      order: "id.asc",
      limit: "2",
    });
    return rows.map(readProductCandidate);
  }

  async findStoresByExternalId(
    inputSourceType: string,
    inputExternalStoreId: string,
  ): Promise<readonly StoreMappingCandidate[]> {
    const sourceType = normalizeSourceType(inputSourceType);
    const externalStoreId = normalizeExternalStoreId(inputExternalStoreId);
    if (!sourceType || !externalStoreId) return [];

    const rows = await this.client.getRows("stores", {
      select: "id,source_type,external_id,active",
      active: "eq.true",
      source_type: postgrestExact(sourceType),
      external_id: postgrestExact(externalStoreId),
      order: "id.asc",
      limit: "2",
    });
    return rows.map(readStoreCandidate);
  }

  async findFirstActiveProductWithBarcode(): Promise<ProductLookupCandidate | null> {
    const rows = await this.client.getRows("products", {
      select: "id,barcode,active",
      active: "eq.true",
      barcode: "not.is.null",
      order: "id.asc",
      limit: SAMPLE_LOOKUP_LIMIT,
    });

    return rows
      .map(readProductCandidate)
      .find((row) => row.active && row.barcode.trim() === row.barcode && row.barcode.length > 0)
      ?? null;
  }

  async findFirstActiveStoreWithExternalId(
    inputSourceType: string,
  ): Promise<StoreMappingCandidate | null> {
    const sourceType = normalizeSourceType(inputSourceType);
    if (!sourceType) return null;

    const rows = await this.client.getRows("stores", {
      select: "id,source_type,external_id,active",
      active: "eq.true",
      source_type: postgrestExact(sourceType),
      external_id: "not.is.null",
      order: "id.asc",
      limit: SAMPLE_LOOKUP_LIMIT,
    });

    return rows
      .map(readStoreCandidate)
      .find(
        (row) =>
          row.active &&
          normalizeSourceType(row.sourceType) === sourceType &&
          row.externalStoreId.trim() === row.externalStoreId &&
          row.externalStoreId.length > 0,
      )
      ?? null;
  }
}