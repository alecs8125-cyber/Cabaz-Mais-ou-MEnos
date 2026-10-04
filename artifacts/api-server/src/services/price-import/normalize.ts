/**
 * Keep barcodes as text: trimming outer whitespace is safe, but converting to
 * a number or removing characters can destroy leading zeroes or change IDs.
 */
export function normalizeBarcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const barcode = value.trim();
  return barcode.length > 0 ? barcode : null;
}

export function normalizeExternalStoreId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const externalStoreId = value.trim();
  return externalStoreId.length > 0 ? externalStoreId : null;
}

export function normalizeSourceType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sourceType = value.trim();
  return sourceType.length > 0 ? sourceType : null;
}