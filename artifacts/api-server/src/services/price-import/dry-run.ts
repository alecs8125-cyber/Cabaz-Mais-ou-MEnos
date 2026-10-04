import { normalizeSourceType } from "./normalize.js";
import { findActiveProductByExactBarcode, findStoreByExternalId } from "./resolve.js";
import type {
  PriceImportDryRunItem,
  PriceImportDryRunReport,
  PriceImportLookup,
  PriceImportSourceAdapter,
  PriceImportStatus,
  PriceFreshnessBucket,
} from "./types.js";
import { validatePriceObservation } from "./validate.js";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

function classifyFreshness(
  capturedAt: string | undefined,
  now: Date,
): { readonly bucket: PriceFreshnessBucket | null; readonly isCurrent: boolean | null } {
  if (!capturedAt) return { bucket: null, isCurrent: null };
  const capturedTimestamp = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTimestamp)) return { bucket: null, isCurrent: null };

  const ageMilliseconds = now.getTime() - capturedTimestamp;
  if (ageMilliseconds < 0) return { bucket: null, isCurrent: false };
  if (ageMilliseconds <= 3 * DAY_MILLISECONDS) {
    return { bucket: "0-3-days", isCurrent: true };
  }
  if (ageMilliseconds <= 7 * DAY_MILLISECONDS) {
    return { bucket: "4-7-days", isCurrent: true };
  }
  if (ageMilliseconds <= 30 * DAY_MILLISECONDS) {
    return { bucket: "8-30-days", isCurrent: false };
  }
  return { bucket: "over-30-days", isCurrent: false };
}

function lookupReason(
  kind: "product" | "store",
  status: "missing" | "ambiguous",
): string {
  if (kind === "product") {
    return status === "missing" ? "product_not_found" : "product_barcode_ambiguous";
  }
  return status === "missing" ? "store_mapping_not_found" : "store_mapping_ambiguous";
}

export async function runPriceImportDryRun(
  source: PriceImportSourceAdapter,
  lookup: PriceImportLookup,
  now: Date = new Date(),
): Promise<PriceImportDryRunReport> {
  const sourceType = normalizeSourceType(source?.sourceType);
  if (!sourceType) throw new Error("O adaptador de importação tem sourceType inválido.");
  if (source.mode !== "external" && source.mode !== "test") {
    throw new Error("O adaptador tem de indicar se a fonte é external ou test.");
  }
  if (typeof source.requiresValidUntil !== "boolean") {
    throw new Error("O adaptador tem de indicar a política de valid_until.");
  }
  if (
    source.validityWindowDays !== undefined &&
    source.validityWindowDays !== null &&
    (!Number.isSafeInteger(source.validityWindowDays) ||
      source.validityWindowDays < 1)
  ) {
    throw new Error("A janela de validade do adaptador tem de ser um número inteiro positivo.");
  }
  if (typeof source.fetchObservations !== "function") {
    throw new Error("O adaptador não implementa fetchObservations.");
  }

  const observations = await source.fetchObservations();
  if (!Array.isArray(observations)) {
    throw new Error("O adaptador devolveu uma lista de preços inválida.");
  }

  const items: PriceImportDryRunItem[] = [];
  for (const input of observations as readonly unknown[]) {
    const validation = validatePriceObservation(
      input,
      sourceType,
      source.requiresValidUntil,
    );
    const preview = validation.valid ? validation.observation : validation.preview;
    const freshness = classifyFreshness(preview.capturedAt, now);
    const validUntilOrigin = preview.validUntilOrigin ?? "missing";
    let validUntil = preview.validUntil ?? null;
    let validUntilMissing = preview.validUntilMissing ?? true;
    let resolvedValidUntilOrigin = validUntilOrigin;
    if (
      validUntilOrigin === "missing" &&
      source.validityWindowDays != null &&
      preview.capturedAt
    ) {
      validUntil = new Date(
        Date.parse(preview.capturedAt) +
          source.validityWindowDays * DAY_MILLISECONDS,
      ).toISOString();
      validUntilMissing = false;
      resolvedValidUntilOrigin = "policy";
    }
    const common = {
      sourceType,
      externalId: preview.externalId ?? null,
      sourceReference: preview.sourceReference ?? null,
      barcode: preview.barcode ?? null,
      storeSourceType: preview.storeSourceType ?? null,
      externalStoreId: preview.externalStoreId ?? null,
      storeMappingUnverified: preview.storeMappingUnverified ?? false,
      sourceStoreOsmType: preview.sourceStoreOsmType ?? null,
      sourceStoreOsmId: preview.sourceStoreOsmId ?? null,
      priceCents: preview.priceCents ?? null,
      currency: preview.currency ?? null,
      promotion: preview.promotion ?? null,
      priceIsDiscounted: preview.priceIsDiscounted ?? null,
      priceWithoutDiscount: preview.priceWithoutDiscount ?? null,
      capturedAt: preview.capturedAt ?? null,
      validFrom: preview.validFrom ?? null,
      validUntil,
      validUntilMissing,
      validUntilOrigin: resolvedValidUntilOrigin,
      freshnessBucket: freshness.bucket,
      isCurrent:
        freshness.isCurrent === null
          ? null
          : freshness.isCurrent &&
            !(
              resolvedValidUntilOrigin === "policy" &&
              validUntil !== null &&
              now.getTime() > Date.parse(validUntil)
            ),
      testOnly: source.mode === "test",
    };

    if (!validation.valid) {
      items.push({
        ...common,
        status: "rejected",
        reasons: validation.errors,
      });
      continue;
    }

    const [product, store] = await Promise.all([
      findActiveProductByExactBarcode(lookup, validation.observation.barcode),
      validation.observation.storeMappingUnverified
        ? Promise.resolve({ status: "missing" as const })
        : findStoreByExternalId(
            lookup,
            validation.observation.storeSourceType,
            validation.observation.externalStoreId!,
          ),
    ]);

    const reasons: string[] = [];
    if (validUntilMissing) {
      reasons.push("valid_until_missing");
    }
    if (
      resolvedValidUntilOrigin === "policy" &&
      validUntil !== null &&
      now.getTime() > Date.parse(validUntil)
    ) {
      reasons.push("stale_price");
    }
    if (product.status !== "matched") reasons.push(lookupReason("product", product.status));
    if (validation.observation.storeMappingUnverified) {
      reasons.push("store_mapping_unverified");
    } else if (store.status !== "matched") {
      reasons.push(lookupReason("store", store.status));
    }

    const status: PriceImportStatus = reasons.length === 0 ? "ready" : "pending";
    items.push({
      ...common,
      status,
      reasons,
      ...(product.status === "matched" ? { productId: product.id } : {}),
      ...(store.status === "matched" ? { storeId: store.id } : {}),
    });
  }

  const counts: Record<PriceImportStatus, number> = {
    ready: 0,
    pending: 0,
    rejected: 0,
  };
  for (const item of items) counts[item.status] += 1;

  return {
    mode: "dry-run",
    sourceType,
    sourceMode: source.mode,
    writesEnabled: false,
    counts,
    items,
  };
}