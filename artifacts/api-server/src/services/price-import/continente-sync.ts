import { matchContinenteProduct, EmptyContinenteMappingRepository } from "./continente-matcher.js";
import { isContinentePriceValid } from "./continente-parser.js";
import {
  ContinenteDatabaseError, type ContinenteSyncRepository, type Row, type SyncProduct,
} from "./continente-sync-repository.js";
import type { ContinenteProductObservation } from "./continente-types.js";

export const CONTINENTE_FRESHNESS_MS = 36 * 60 * 60 * 1000;
interface Resolution {
  product: SyncProduct | null;
  method: string;
  confidence: number;
}
export interface ContinenteSyncReport {
  mode: "dry-run" | "commit";
  writesEnabled: boolean;
  blockers: string[];
  onlineStore: { id: string | null; name: "Continente Online"; action: "reuse" | "create" };
  counts: {
    processed: number; sourceNativeCreated: number; existingReused: number;
    nativePlanned: number; mappingsCreated: number; pricesWritten: number;
    historyCreated: number | null; pricesWith36h: number | null; errors: number;
  };
  items: {
    sku: string | null; name: string | null; productId: string | null;
    method: string | null; action: string; error: string | null;
  }[];
}

function nativeFields(observation: ContinenteProductObservation, creating: boolean): Row {
  const fields: Row = { name: observation.name, active: true };
  if (creating) Object.assign(fields, {
    source_type: "continente", external_id: observation.externalProductId,
    brand: null, barcode: null, image_url: null, category: null,
    package_quantity: null, package_unit: null, unit: null,
  });
  if (observation.brand?.trim()) fields.brand = observation.brand;
  if (observation.barcode) fields.barcode = observation.barcode;
  if (observation.image) {
    try {
      const url = new URL(observation.image);
      if (url.protocol === "https:" && !url.username && !url.password) fields.image_url = url.toString();
    } catch { /* Missing/invalid images never overwrite existing source data. */ }
  }
  if (observation.packageQuantity !== null && Number.isFinite(observation.packageQuantity) &&
      observation.packageQuantity > 0 && observation.packageUnit?.trim()) {
    fields.package_quantity = observation.packageQuantity;
    fields.package_unit = observation.packageUnit;
    fields.unit = observation.packageUnit;
  }
  return fields;
}

function validatedIdentity(observation: ContinenteProductObservation): string {
  const sku = observation.externalProductId;
  const url = new URL(observation.sourceReference);
  if (!sku || !/^[1-9]\d*$/.test(sku) || sku !== observation.sku ||
      sku !== observation.mpn || sku !== observation.urlProductId ||
      observation.sourceType !== "continente" || observation.priceScope !== "online" ||
      url.origin !== "https://www.continente.pt" || !url.pathname.startsWith("/produto/") ||
      !url.pathname.endsWith(`-${sku}.html`) || url.search || url.hash ||
      !observation.name?.trim()) {
    throw new Error("Invalid product identity/name; no mutation permitted.");
  }
  return sku;
}

export function continentePriceArguments(
  observation: ContinenteProductObservation, productId: string, storeId: string,
  now = new Date(),
): Row {
  const sku = validatedIdentity(observation);
  const captured = Date.parse(observation.capturedAt);
  const price = observation.price ?? "";
  const amount = Number(price);
  if (!isContinentePriceValid(observation) || !/^[0-9]+\.[0-9]{2}$/.test(price) ||
      !Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER / 100 ||
      !Number.isFinite(captured) ||
      captured > now.getTime() || captured + CONTINENTE_FRESHNESS_MS <= now.getTime() ||
      /outofstock|soldout|out of stock/i.test(observation.availability ?? "")) {
    throw new Error("No fresh, available, positive EUR price; price RPC skipped.");
  }
  return {
    p_product_id: productId, p_store_id: storeId, p_price: observation.price,
    p_currency: "EUR", p_captured_at: observation.capturedAt,
    p_valid_from: observation.capturedAt,
    p_valid_until: new Date(captured + CONTINENTE_FRESHNESS_MS).toISOString(),
    p_source_type: "continente", p_external_id: `online:${sku}`,
    p_source_reference: observation.sourceReference,
    p_promotion: observation.promotion !== null || observation.regularPrice !== null,
  };
}

async function resolveProduct(
  observation: ContinenteProductObservation, repository: ContinenteSyncRepository,
  catalog: readonly SyncProduct[], mappingsAvailable: boolean,
): Promise<Resolution> {
  const sku = validatedIdentity(observation);
  const mappings = mappingsAvailable ? await repository.findMappings(sku) : [];
  if (mappings.length > 1) throw new Error("Multiple mappings for the same SKU.");
  if (mappings.length === 1) {
    const mapping = mappings[0]!;
    if (!mapping.verified || mapping.sourceType !== "continente" ||
        mapping.externalProductId !== sku || mapping.confidence < 0 || mapping.confidence > 1) {
      throw new Error("Unverified/invalid persisted mapping; manual resolution required.");
    }
    const target = await repository.findProduct(mapping.productId);
    if (!target || !target.active) throw new Error("Mapping target is absent/inactive.");
    const native = await repository.findSourceProducts(sku);
    if (native.length > 1 || (native.length === 1 && native[0]!.id !== target.id)) {
      throw new Error("Conflicting mapping/source-native identities.");
    }
    return { product: target, method: mapping.matchMethod, confidence: mapping.confidence };
  }
  const sourceProducts = await repository.findSourceProducts(sku);
  if (sourceProducts.length > 1) throw new Error("Multiple source-native products for the same SKU.");
  if (sourceProducts.length === 1) return { product: sourceProducts[0]!, method: "source_native", confidence: 1 };

  const match = await matchContinenteProduct(
    observation, catalog,
    new EmptyContinenteMappingRepository(),
  );
  if (match.product && (match.method === "barcode_exact" ||
      // A barcode can legitimately identify the same product across source SKUs;
      // name-only equality cannot collapse two different source-native SKUs.
      (match.method === "name_brand_exact_unique" &&
        catalog.find((candidate) => candidate.id === match.product!.id)?.sourceType !== "continente" &&
        observation.brand?.trim() && match.product.brand?.trim()))) {
    const target = catalog.find((candidate) => candidate.id === match.product!.id)!;
    return { product: target, method: match.method, confidence: match.confidence };
  }
  // An ambiguous catalog match means a distinct source-native product, never an arbitrary candidate.
  return { product: null, method: "source_native", confidence: 1 };
}

export async function syncContinenteObservations(
  observations: readonly ContinenteProductObservation[],
  repository: ContinenteSyncRepository,
  now = new Date(),
): Promise<ContinenteSyncReport> {
  if (observations.length > (repository.commitEnabled ? 20 : 200)) throw new Error("Sync batch exceeds its safety limit.");
  const preflight = await repository.preflight();
  if (repository.commitEnabled && preflight.blockers.length) {
    throw new Error(`Commit preflight failed before any write: ${preflight.blockers.join(" ")}`);
  }
  let store = await repository.findOnlineStore();
  const onlineAction = store ? "reuse" : "create";
  if (repository.commitEnabled && !store) store = await repository.createOnlineStore();
  const catalog = await repository.loadCatalog();
  const report: ContinenteSyncReport = {
    mode: repository.commitEnabled ? "commit" : "dry-run", writesEnabled: repository.commitEnabled,
    blockers: preflight.blockers,
    onlineStore: { id: store?.id ?? null, name: "Continente Online", action: onlineAction },
    counts: { processed: 0, sourceNativeCreated: 0, existingReused: 0, nativePlanned: 0, mappingsCreated: 0, pricesWritten: 0, historyCreated: 0, pricesWith36h: 0, errors: 0 },
    items: [],
  };
  const skuCounts = new Map<string, number>();
  for (const item of observations) if (item.externalProductId) {
    skuCounts.set(item.externalProductId, (skuCounts.get(item.externalProductId) ?? 0) + 1);
  }
  for (const observation of observations) {
    const item = { sku: observation.externalProductId, name: observation.name, productId: null as string | null, method: null as string | null, action: "error", error: null as string | null };
    report.items.push(item);
    report.counts.processed += 1;
    try {
      const sku = validatedIdentity(observation);
      if (skuCounts.get(sku)! > 1) throw new Error("Duplicate SKU in the batch; no arbitrary observation chosen.");
      const resolution = await resolveProduct(observation, repository, catalog, preflight.mappingsAvailable);
      item.method = resolution.method;
      let target = resolution.product;
      if (!target) {
        if (!repository.commitEnabled) {
          report.counts.nativePlanned += 1;
          item.action = "would_create_source_native";
        } else {
          // Recheck immediately before INSERT; a unique source identity index handles concurrent workers.
          const existing = await repository.findSourceProducts(sku);
          if (existing.length > 1) throw new Error("Non-unique SKU before insert.");
          target = existing[0] ?? null;
          if (!target) {
            try {
              target = await repository.createNative(nativeFields(observation, true));
              report.counts.sourceNativeCreated += 1;
              item.action = "created_source_native";
            } catch (error) {
              if (!(error instanceof ContinenteDatabaseError) || error.status !== 409) throw error;
              const raced = await repository.findSourceProducts(sku);
              if (raced.length !== 1) throw new Error("Unresolved concurrent product insertion.");
              target = raced[0]!;
            }
          }
        }
      }
      if (target) {
        if (!catalog.some((candidate) => candidate.id === target.id)) catalog.push(target);
        item.productId = target.id;
        if (item.action !== "created_source_native") {
          report.counts.existingReused += 1;
          item.action = repository.commitEnabled ? "reused" : "would_reuse";
        }
        if (repository.commitEnabled) {
          if (target.sourceType === "continente" && target.externalId === sku) {
            await repository.updateNative(target.id, nativeFields(observation, false));
          }
          const previousMappings = await repository.findMappings(sku);
          if (previousMappings.length > 1 || (previousMappings[0] &&
              (previousMappings[0].productId !== target.id || !previousMappings[0].verified))) {
            throw new Error("Mapping changed during resolution.");
          }
          if (!previousMappings.length && await repository.createMapping({
            source_type: "continente", external_product_id: sku, product_id: target.id,
            match_method: resolution.method, confidence: resolution.confidence, verified: true,
          })) report.counts.mappingsCreated += 1;
        }
      }
      // Validate freshness even in dry run, without inventing a product/store ID.
      const args = continentePriceArguments(observation, target?.id ?? "", store?.id ?? "", now);
      if (repository.commitEnabled && target && store) {
        const result = await repository.upsertPrice(args);
        if (result.kind === "uuid") {
          report.counts.pricesWritten += 1;
          report.counts.historyCreated = null;
          report.counts.pricesWith36h = null;
        } else if (!result.stale_observation) {
          report.counts.pricesWritten += 1;
          if (report.counts.pricesWith36h !== null) report.counts.pricesWith36h += 1;
          if (report.counts.historyCreated !== null && result.history_created) {
            report.counts.historyCreated += 1;
          }
        } else item.action = "stale_observation_skipped";
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : "Unexpected sync error.";
      report.counts.errors += 1;
    }
  }
  return report;
}