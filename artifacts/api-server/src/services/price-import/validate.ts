import {
  normalizeBarcode,
  normalizeExternalStoreId,
  normalizeSourceType,
} from "./normalize.js";
import type { ExternalPriceObservation, ValidUntilOrigin } from "./types.js";

export interface ValidatedPriceObservation {
  readonly sourceType: string;
  readonly externalId: string;
  readonly sourceReference: string | null;
  readonly barcode: string;
  readonly storeSourceType: string;
  readonly externalStoreId: string | null;
  readonly storeMappingUnverified: boolean;
  readonly sourceStoreOsmType: string | null;
  readonly sourceStoreOsmId: string | null;
  readonly priceCents: number;
  readonly currency: string;
  readonly promotion: string | null;
  readonly priceIsDiscounted: boolean | null;
  readonly priceWithoutDiscount: string | number | null;
  readonly capturedAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly validUntilMissing: boolean;
  readonly validUntilOrigin: ValidUntilOrigin;
}

export type PriceObservationValidation =
  | {
      readonly valid: true;
      readonly observation: ValidatedPriceObservation;
    }
  | {
      readonly valid: false;
      readonly errors: readonly string[];
      readonly preview: Partial<ValidatedPriceObservation>;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function parsePriceCents(value: unknown): number | null {
  const amount = typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";

  // EUR values are represented to the cent; reject locale-formatted or
  // over-precise values instead of silently rounding them.
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;

  const [eurosText, centsText = ""] = amount.split(".");
  const cents = Number(eurosText) * 100 + Number(centsText.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

type DateField = { readonly state: "missing" | "invalid" | "valid"; readonly value: string | null };

function parseDateField(value: unknown): DateField {
  if (value === undefined || value === null) {
    return { state: "missing", value: null };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { state: "invalid", value: null };
  }

  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) return { state: "invalid", value: null };
  return { state: "valid", value: new Date(timestamp).toISOString() };
}

function readOptionalText(
  value: unknown,
  field: string,
  errors: string[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push(`${field}_invalid`);
    return null;
  }
  return value.trim() || null;
}

function readOptionalBoolean(
  value: unknown,
  field: string,
  errors: string[],
): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    errors.push(`${field}_invalid`);
    return null;
  }
  return value;
}

function readOptionalPrice(
  value: unknown,
  field: string,
  errors: string[],
): string | number | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    parsePriceCents(value) === null
  ) {
    errors.push(`${field}_invalid`);
    return null;
  }
  return value;
}

export function validatePriceObservation(
  input: unknown,
  expectedSourceType: string,
  requiresValidUntil: boolean,
): PriceObservationValidation {
  const errors: string[] = [];
  const record = asRecord(input);
  if (!record) {
    return { valid: false, errors: ["record_invalid"], preview: {} };
  }

  const sourceType = normalizeSourceType(record.sourceType);
  const externalId = readText(record.externalId);
  const barcode = normalizeBarcode(record.barcode);
  const storeSourceType = normalizeSourceType(record.storeSourceType);
  const externalStoreId = normalizeExternalStoreId(record.externalStoreId);
  const storeMappingUnverifiedValue = readOptionalBoolean(
    record.storeMappingUnverified,
    "store_mapping_unverified",
    errors,
  );
  const storeMappingUnverified = storeMappingUnverifiedValue ?? false;
  const sourceStoreOsmType = readOptionalText(
    record.sourceStoreOsmType,
    "source_store_osm_type",
    errors,
  );
  const sourceStoreOsmId = readOptionalText(
    record.sourceStoreOsmId,
    "source_store_osm_id",
    errors,
  );
  const currency = readText(record.currency)?.toUpperCase() ?? null;
  const priceCents = parsePriceCents(record.price);
  const capturedAt = parseDateField(record.capturedAt);
  const validFrom = parseDateField(record.validFrom);
  const validUntil = parseDateField(record.validUntil);
  const sourceReference = readOptionalText(record.sourceReference, "source_reference", errors);
  const promotion = readOptionalText(record.promotion, "promotion", errors);
  const priceIsDiscounted = readOptionalBoolean(
    record.priceIsDiscounted,
    "price_is_discounted",
    errors,
  );
  const priceWithoutDiscount = readOptionalPrice(
    record.priceWithoutDiscount,
    "price_without_discount",
    errors,
  );

  if (!sourceType) errors.push("source_type_missing");
  else if (sourceType !== expectedSourceType) errors.push("source_type_mismatch");
  if (!externalId) errors.push("external_id_missing");
  if (!barcode) errors.push("barcode_missing");
  if (!storeSourceType) errors.push("store_source_type_missing");
  if (!externalStoreId && !storeMappingUnverified) {
    errors.push("external_store_id_missing");
  }
  if (
    storeMappingUnverified &&
    (externalStoreId !== null || !sourceStoreOsmType || !sourceStoreOsmId)
  ) {
    errors.push("store_mapping_state_invalid");
  }
  if (priceCents === null) errors.push("price_invalid");
  if (currency !== "EUR") errors.push("currency_not_eur");
  if (capturedAt.state !== "valid") errors.push("captured_at_invalid");
  if (validFrom.state === "invalid") errors.push("valid_from_invalid");
  if (validUntil.state === "missing" && requiresValidUntil) {
    errors.push("valid_until_required");
  } else if (validUntil.state === "invalid") {
    errors.push("valid_until_invalid");
  }
  if (
    validFrom.value !== null &&
    validUntil.value !== null &&
    Date.parse(validFrom.value) > Date.parse(validUntil.value)
  ) {
    errors.push("validity_window_invalid");
  }

  const preview: Partial<ValidatedPriceObservation> = {
    ...(sourceType ? { sourceType } : {}),
    ...(externalId ? { externalId } : {}),
    sourceReference,
    ...(barcode ? { barcode } : {}),
    ...(storeSourceType ? { storeSourceType } : {}),
    externalStoreId,
    storeMappingUnverified,
    sourceStoreOsmType,
    sourceStoreOsmId,
    ...(priceCents !== null ? { priceCents } : {}),
    ...(currency ? { currency } : {}),
    promotion,
    priceIsDiscounted,
    priceWithoutDiscount,
    ...(capturedAt.value ? { capturedAt: capturedAt.value } : {}),
    validFrom: validFrom.value,
    validUntil: validUntil.value,
    validUntilMissing: validUntil.state === "missing",
    validUntilOrigin: validUntil.state === "missing" ? "missing" : "source",
  };

  if (errors.length > 0) return { valid: false, errors, preview };

  return {
    valid: true,
    observation: {
      sourceType: sourceType!,
      externalId: externalId!,
      sourceReference,
      barcode: barcode!,
      storeSourceType: storeSourceType!,
      externalStoreId,
      storeMappingUnverified,
      sourceStoreOsmType,
      sourceStoreOsmId,
      priceCents: priceCents!,
      currency: "EUR",
      promotion,
      priceIsDiscounted,
      priceWithoutDiscount,
      capturedAt: capturedAt.value!,
      validFrom: validFrom.value,
      validUntil: validUntil.value,
      validUntilMissing: validUntil.state === "missing",
      validUntilOrigin: validUntil.state === "missing" ? "missing" : "source",
    },
  };
}

export type { ExternalPriceObservation };