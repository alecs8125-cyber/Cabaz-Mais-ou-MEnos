import {
  EmptyContinenteMappingRepository,
  matchAuchanProduct,
} from "./continente-matcher.js";
import { isAuchanPriceValid } from "./auchan-parser.js";
import type {
  ContinenteCatalogProduct,
  ContinenteExternalProductMapping,
} from "./continente-types.js";
import type { AuchanDryRunItem } from "./auchan-dry-run.js";
import {
  AUCHAN_PRICE_FRESHNESS_MS,
  type AuchanProductObservation,
} from "./auchan-types.js";
import type {
  AuchanPreflight,
  AuchanReferenceStore,
  AuchanStoredPrice,
  AuchanProductWrite,
} from "./supabase-auchan-sync-repository.js";

type Row = Record<string, unknown>;

export interface AuchanSyncRepository {
  readonly commitEnabled: boolean;
  preflight(): Promise<AuchanPreflight>;
  findMappings(externalProductId: string): Promise<ContinenteExternalProductMapping[]>;
  findSourceProducts(externalProductId: string): Promise<ContinenteCatalogProduct[]>;
  findProduct(id: string): Promise<ContinenteCatalogProduct | null>;
  createNative(fields: Row): Promise<AuchanProductWrite>;
  createMapping(fields: Row): Promise<boolean>;
  upsertReferencePrice(args: Row): Promise<unknown>;
  findReferencePrice(
    productId: string,
    storeId: string,
    sourceReference: string,
    capturedAt: string,
  ): Promise<AuchanStoredPrice | null>;
  hasReferencePriceHistory(
    productId: string,
    storeId: string,
    price: string,
    capturedAt: string,
  ): Promise<boolean>;
}

export interface AuchanSyncReport {
  mode: "dry-run" | "commit";
  writesEnabled: boolean;
  blockers: string[];
  referenceStore: {
    id: string | null;
    name: "Auchan Online · referência 2650-435 (Amadora)";
    action: "reuse" | "missing";
    creationAllowed: false;
  };
  counts: {
    processed: number;
    sourceNativeCreated: number;
    existingReused: number;
    nativePlanned: number;
    mappingsCreated: number;
    pricesWritten: number;
    historyRowsConfirmed: number | null;
    errors: number;
  };
  items: {
    sku: string | null;
    name: string;
    productId: string | null;
    method: string | null;
    action: string;
    rpcAcknowledgementResolved: boolean;
    error: string | null;
  }[];
}

interface Resolution {
  readonly product: ContinenteCatalogProduct | null;
  readonly method: string;
  readonly confidence: number;
}

const DISPLAY_STORE_NAME = "Auchan Online · referência 2650-435 (Amadora)";
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalizeAmount(value: string): string {
  return Number(value).toFixed(2);
}

function safeImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function validatedObservation(
  observation: AuchanProductObservation,
  now: number,
): string {
  const id = observation.externalProductId;
  let url: URL;
  try {
    url = new URL(observation.sourceReference);
  } catch {
    throw new Error("Invalid Auchan product URL.");
  }
  const capturedAt = Date.parse(observation.capturedAt);
  const amount = Number(observation.price);
  if (
    observation.sourceType !== "auchan" ||
    !id ||
    !/^[1-9]\d*$/.test(id) ||
    id !== observation.sku ||
    id !== observation.urlProductId ||
    url.origin !== "https://www.auchan.pt" ||
    !url.pathname.startsWith("/pt/") ||
    !url.pathname.endsWith(`/${id}.html`) ||
    url.search ||
    url.hash ||
    observation.priceScope !== "reference_only_2650_435" ||
    !observation.priceScopeEvidence ||
    !isAuchanPriceValid(observation) ||
    !/^(?:0|[1-9]\d*)\.\d{1,2}$/.test(observation.price ?? "") ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > Number.MAX_SAFE_INTEGER / 100 ||
    !Number.isFinite(capturedAt) ||
    capturedAt > now ||
    capturedAt + AUCHAN_PRICE_FRESHNESS_MS <= now ||
    /outofstock|soldout|out of stock/i.test(observation.availability ?? "")
  ) throw new Error("Observation is not safe for an Auchan Amadora reference-price import.");
  return id;
}

function nativeProductFields(
  observation: AuchanProductObservation,
  externalProductId: string,
): Row {
  const fields: Row = {
    name: observation.name.trim(),
    source_type: "auchan",
    external_id: externalProductId,
    active: true,
    brand: null,
    barcode: null,
    image_url: null,
    category: null,
    package_quantity: null,
    package_unit: null,
    unit: null,
  };
  if (observation.brand?.trim()) fields.brand = observation.brand.trim();
  if (observation.barcode) fields.barcode = observation.barcode;
  const image = safeImageUrl(observation.image);
  if (image) fields.image_url = image;
  if (
    observation.packageQuantity !== null &&
    Number.isFinite(observation.packageQuantity) &&
    observation.packageQuantity > 0 &&
    observation.packageUnit?.trim()
  ) {
    fields.package_quantity = observation.packageQuantity;
    fields.package_unit = observation.packageUnit.trim();
    fields.unit = observation.packageUnit.trim();
  }
  return fields;
}

async function resolveProduct(
  item: AuchanDryRunItem,
  repository: AuchanSyncRepository,
): Promise<Resolution> {
  const sku = item.observation.externalProductId!;
  const mappings = await repository.findMappings(sku);
  const sourceProducts = await repository.findSourceProducts(sku);
  if (mappings.length > 1) throw new Error("Multiple persisted mappings for one Auchan product.");
  if (sourceProducts.length > 1) throw new Error("Multiple source-native products for one Auchan SKU.");

  if (mappings.length === 1) {
    const mapping = mappings[0]!;
    if (
      !mapping.verified ||
      mapping.sourceType !== "auchan" ||
      mapping.externalProductId !== sku ||
      !Number.isFinite(mapping.confidence) ||
      mapping.confidence < 0 ||
      mapping.confidence > 1
    ) throw new Error("The persisted Auchan mapping is unverified or invalid.");
    if (sourceProducts.length && sourceProducts[0]!.id !== mapping.productId) {
      throw new Error("The Auchan mapping conflicts with a source-native product.");
    }
    const product = await repository.findProduct(mapping.productId);
    if (!product?.active) throw new Error("The verified Auchan mapping points to a missing or inactive product.");
    return { product, method: mapping.matchMethod, confidence: mapping.confidence };
  }

  if (sourceProducts.length === 1) {
    const product = sourceProducts[0]!;
    if (!product.active) throw new Error("The exact source-native Auchan product is inactive.");
    return { product, method: "source_native_exact", confidence: 1 };
  }

  if (
    item.match.method === "verified_external_mapping" ||
    item.match.method === "source_native_exact" ||
    item.match.method === "source_native_inactive" ||
    item.match.level === "ambiguous"
  ) throw new Error("The dry-run identity resolution changed before commit.");

  const currentMatch = await matchAuchanProduct(
    item.observation,
    item.match.product ? [item.match.product] : [],
    new EmptyContinenteMappingRepository(),
  );
  if (
    (currentMatch.level === "exact" || currentMatch.level === "high_confidence") &&
    currentMatch.product
  ) {
    const product = await repository.findProduct(currentMatch.product.id);
    if (!product?.active) throw new Error("The matched catalog product is missing or inactive.");
    return {
      product,
      method: currentMatch.method ?? "catalog_match",
      confidence: currentMatch.confidence,
    };
  }
  if (item.match.level === "exact" || item.match.level === "high_confidence") {
    throw new Error("The dry-run catalog match could not be revalidated.");
  }
  return { product: null, method: "source_native", confidence: 1 };
}

function priceRpcArguments(
  observation: AuchanProductObservation,
  productId: string,
): Row {
  const sku = observation.externalProductId!;
  return {
    p_product_id: productId,
    p_price: Number(observation.price),
    p_promotion: observation.promotion !== null || observation.regularPrice !== null,
    p_captured_at: observation.capturedAt,
    p_source_reference: observation.sourceReference,
    p_external_product_id: sku,
  };
}

function newReport(
  repository: AuchanSyncRepository,
  preflight: AuchanPreflight,
  items: AuchanDryRunItem[],
): AuchanSyncReport {
  return {
    mode: repository.commitEnabled ? "commit" : "dry-run",
    writesEnabled: repository.commitEnabled,
    blockers: [...preflight.blockers],
    referenceStore: {
      id: preflight.referenceStore?.id ?? null,
      name: DISPLAY_STORE_NAME,
      action: preflight.referenceStore ? "reuse" : "missing",
      creationAllowed: false,
    },
    counts: {
      processed: items.length,
      sourceNativeCreated: 0,
      existingReused: 0,
      nativePlanned: 0,
      mappingsCreated: 0,
      pricesWritten: 0,
      historyRowsConfirmed: repository.commitEnabled ? 0 : null,
      errors: 0,
    },
    items: items.map((item) => ({
      sku: item.observation.externalProductId,
      name: item.observation.name,
      productId: null,
      method: null,
      action: "pending",
      rpcAcknowledgementResolved: false,
      error: null,
    })),
  };
}

export async function syncAuchanObservations(
  observations: readonly AuchanDryRunItem[],
  repository: AuchanSyncRepository,
  now = new Date(),
): Promise<AuchanSyncReport> {
  if (observations.length > (repository.commitEnabled ? 20 : 200)) {
    throw new Error("Auchan sync batch exceeds its safety limit.");
  }
  const batch = [...observations];
  const report = newReport(repository, await repository.preflight(), batch);
  const skuCounts = new Map<string, number>();
  for (const item of batch) {
    const sku = item.observation.externalProductId;
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  }

  const resolutions: Array<Resolution | null> = [];
  const preparationErrors: string[] = [];
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index]!;
    const row = report.items[index]!;
    try {
      const sku = validatedObservation(item.observation, now.getTime());
      if (!item.identityStable || !item.priceSafeToImport) {
        throw new Error("Dry-run did not confirm a stable, importable reference observation.");
      }
      if (skuCounts.get(sku) !== 1) throw new Error("Duplicate Auchan SKU in the batch.");
      if (report.blockers.length) throw new Error(report.blockers.join(" "));
      if (!report.referenceStore.id) throw new Error("The exact Auchan reference store is unavailable.");
      if (!item.observation.name.trim()) throw new Error("Product name is missing.");
      const resolution = await resolveProduct(item, repository);
      resolutions.push(resolution);
      row.method = resolution.method;
      row.productId = resolution.product?.id ?? null;
      row.action = resolution.product
        ? repository.commitEnabled ? "reuse_product" : "would_reuse_product"
        : repository.commitEnabled ? "create_source_native" : "would_create_source_native";
      if (resolution.product && !repository.commitEnabled) {
        report.counts.existingReused += 1;
      } else if (!resolution.product && !repository.commitEnabled) {
        report.counts.nativePlanned += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected pre-commit error.";
      row.error = message;
      row.action = "blocked";
      report.counts.errors += 1;
      preparationErrors.push(message);
      resolutions.push(null);
    }
  }

  if (repository.commitEnabled && preparationErrors.length) {
    return {
      ...report,
      blockers: [...report.blockers, "Batch validation failed before the first write."],
    };
  }
  if (repository.commitEnabled && report.blockers.length) return report;

  let stopAfterError = false;
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index]!;
    const resolution = resolutions[index];
    const row = report.items[index]!;
    if (!resolution) continue;
    if (!repository.commitEnabled) continue;
    if (stopAfterError) {
      row.action = "not_attempted_after_prior_error";
      continue;
    }

    try {
      const sku = item.observation.externalProductId!;
      let target = resolution.product;
      if (!target) {
        const racedMappings = await repository.findMappings(sku);
        if (racedMappings.length) {
          throw new Error("A mapping appeared after batch validation; refusing an arbitrary target.");
        }
        const racedProducts = await repository.findSourceProducts(sku);
        if (racedProducts.length > 1) throw new Error("Non-unique source-native identity before insert.");
        if (racedProducts.length === 1) {
          if (!racedProducts[0]!.active) throw new Error("Source-native product became inactive before insert.");
          target = racedProducts[0]!;
          row.method = "source_native_exact";
        } else {
          const created = await repository.createNative(
            nativeProductFields(item.observation, sku),
          );
          target = created.product;
          if (!target.active || target.sourceType !== "auchan" || target.externalId !== sku) {
            throw new Error("Created product did not reconcile to the expected Auchan identity.");
          }
          if (created.inserted) report.counts.sourceNativeCreated += 1;
          else report.counts.existingReused += 1;
          row.action = created.inserted ? "created_source_native" : "reused_source_native";
        }
      } else {
        report.counts.existingReused += 1;
        row.action = "reused_product";
      }

      if (!UUID_PATTERN.test(target.id)) throw new Error("Resolved product ID is not a valid UUID.");
      row.productId = target.id;
      const mappings = await repository.findMappings(sku);
      if (mappings.length > 1) throw new Error("Multiple Auchan mappings appeared during commit.");
      if (!mappings.length) {
        const created = await repository.createMapping({
          source_type: "auchan",
          external_product_id: sku,
          product_id: target.id,
          match_method: row.method ?? resolution.method,
          confidence: resolution.confidence,
          verified: true,
        });
        if (created) report.counts.mappingsCreated += 1;
      } else if (
        mappings[0]!.productId !== target.id ||
        mappings[0]!.sourceType !== "auchan" ||
        mappings[0]!.externalProductId !== sku ||
        !mappings[0]!.verified
      ) {
        throw new Error("The persisted mapping changed to a conflicting Auchan product.");
      }

      let rpcError: string | null = null;
      try {
        await repository.upsertReferencePrice(
          priceRpcArguments(item.observation, target.id),
        );
      } catch (error) {
        rpcError = error instanceof Error ? error.message : "Unknown RPC acknowledgement failure.";
      }

      const storeId = report.referenceStore.id!;
      const expectedPrice = normalizeAmount(item.observation.price!);
      const [storedPrice, historyExists] = await Promise.all([
        repository.findReferencePrice(
          target.id,
          storeId,
          item.observation.sourceReference,
          item.observation.capturedAt,
        ),
        repository.hasReferencePriceHistory(
          target.id,
          storeId,
          expectedPrice,
          item.observation.capturedAt,
        ),
      ]);
      const expectedCapturedAt = Date.parse(item.observation.capturedAt);
      const storedPriceMatches = storedPrice !== null &&
        storedPrice.id.trim().length > 0 &&
        storedPrice.productId === target.id &&
        storedPrice.storeId === storeId &&
        storedPrice.price === expectedPrice &&
        storedPrice.currency === "EUR" &&
        storedPrice.sourceType === "auchan" &&
        storedPrice.sourceReference === item.observation.sourceReference &&
        storedPrice.verificationStatus === "verified" &&
        Number.isFinite(Date.parse(storedPrice.capturedAt)) &&
        Date.parse(storedPrice.capturedAt) === expectedCapturedAt &&
        storedPrice.validUntil !== null &&
        Number.isFinite(Date.parse(storedPrice.validUntil)) &&
        Date.parse(storedPrice.validUntil) === expectedCapturedAt + AUCHAN_PRICE_FRESHNESS_MS;
      if (!storedPriceMatches || !historyExists) {
        row.action = "price_readback_failed";
        row.error = rpcError
          ? `RPC acknowledgement was uncertain and GET reconciliation did not confirm price and history: ${rpcError}`
          : "GET reconciliation did not confirm the expected verified price and history; no retry was attempted.";
        report.counts.errors += 1;
        stopAfterError = true;
        continue;
      }
      report.counts.pricesWritten += 1;
      if (report.counts.historyRowsConfirmed !== null) {
        report.counts.historyRowsConfirmed += 1;
      }
      row.action = "price_and_history_confirmed";
      row.rpcAcknowledgementResolved = rpcError !== null;
      if (rpcError) row.error = `RPC acknowledgement recovered by GET verification: ${rpcError}`;
    } catch (error) {
      row.action = "item_write_failed";
      row.error = error instanceof Error ? error.message : "Unexpected Auchan write error.";
      report.counts.errors += 1;
      stopAfterError = true;
    }
  }
  return report;
}