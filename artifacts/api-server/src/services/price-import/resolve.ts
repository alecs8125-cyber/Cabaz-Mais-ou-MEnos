import { normalizeBarcode, normalizeExternalStoreId, normalizeSourceType } from "./normalize.js";
import type { PriceImportLookup } from "./types.js";

export type LookupResolution =
  | { readonly status: "matched"; readonly id: string }
  | { readonly status: "missing" | "ambiguous" };

export async function findActiveProductByExactBarcode(
  lookup: PriceImportLookup,
  inputBarcode: string,
): Promise<LookupResolution> {
  const barcode = normalizeBarcode(inputBarcode);
  if (!barcode) return { status: "missing" };

  const candidates = await lookup.findActiveProductsByExactBarcode(barcode);
  const matches = candidates.filter((candidate) =>
    candidate.active === true &&
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    normalizeBarcode(candidate.barcode) === barcode
  );

  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "matched", id: matches[0]!.id.trim() };
}

export async function findStoreByExternalId(
  lookup: PriceImportLookup,
  inputSourceType: string,
  inputExternalStoreId: string,
): Promise<LookupResolution> {
  const sourceType = normalizeSourceType(inputSourceType);
  const externalStoreId = normalizeExternalStoreId(inputExternalStoreId);
  if (!sourceType || !externalStoreId) return { status: "missing" };

  const candidates = await lookup.findStoresByExternalId(sourceType, externalStoreId);
  const matches = candidates.filter((candidate) =>
    candidate.active === true &&
    typeof candidate.storeId === "string" &&
    candidate.storeId.trim().length > 0 &&
    normalizeSourceType(candidate.sourceType) === sourceType &&
    normalizeExternalStoreId(candidate.externalStoreId) === externalStoreId
  );

  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "matched", id: matches[0]!.storeId.trim() };
}