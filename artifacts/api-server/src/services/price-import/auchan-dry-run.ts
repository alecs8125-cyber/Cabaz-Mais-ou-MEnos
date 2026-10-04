import { matchAuchanProduct } from "./continente-matcher.js";
import type {
  ContinenteCatalogProduct,
  ContinenteMappingRepository,
  ContinenteProductMatch,
} from "./continente-types.js";
import { AuchanAdapter } from "./auchan-adapter.js";
import { isAuchanPriceValid } from "./auchan-parser.js";
import type {
  AuchanAdapterAudit,
  AuchanProductObservation,
} from "./auchan-types.js";

export interface AuchanCatalogReader {
  loadAllProducts(): Promise<ContinenteCatalogProduct[]>;
}

export type AuchanPlannedProductAction =
  | "use_existing_product"
  | "create_source_native"
  | "review_existing_inactive"
  | "review_ambiguous"
  | "review_identity";

export interface AuchanDryRunItem {
  readonly observation: AuchanProductObservation;
  readonly match: ContinenteProductMatch;
  readonly plannedProductAction: AuchanPlannedProductAction;
  readonly priceUsableForProduct: boolean;
  readonly priceSafeToImport: false;
}

export interface AuchanDryRunReport {
  readonly execution: "read-only-auchan-dry-run";
  readonly mode: "dry-run";
  readonly sourceType: "auchan";
  readonly priceScope: "reference_only_2650_435" | "unknown_or_mixed";
  readonly writesEnabled: false;
  readonly storeCreationEnabled: false;
  readonly pageRequestBudget: number;
  readonly firstPassLimit: number;
  readonly catalogProductsLoaded: number;
  readonly audit: AuchanAdapterAudit;
  readonly counts: Readonly<{
    pagesRequested: number;
    firstPassPages: number;
    stabilityRereads: number;
    productsExtracted: number;
    pricesExtracted: number;
    validExternalIds: number;
    skuUrlIdMatches: number;
    duplicateExternalIds: number;
    productsWithoutId: number;
    formatsExtracted: number;
    promotionsFound: number;
    barcodesFound: number;
    exactMatches: number;
    highConfidenceMatches: number;
    ambiguousMatches: number;
    unmatched: number;
    sourceNativeCandidates: number;
    sourceNativeInactive: number;
    pricesUsableForProduct: number;
    pricesSafeToImport: 0;
    httpErrors: number;
    redirects: number;
    invalidPages: number;
    blockedPages: number;
  }>;
  readonly items: readonly AuchanDryRunItem[];
}

export interface AuchanDryRunOptions {
  /** Total product-page HTTP request budget, including stable-ID rereads. */
  readonly pageRequestBudget?: number;
  readonly stabilityReads?: number;
  readonly offset?: number;
}

function uniqueObservations(audit: AuchanAdapterAudit): {
  readonly observations: AuchanProductObservation[];
  readonly duplicateExternalIds: number;
} {
  const observations: AuchanProductObservation[] = [];
  const seenUrls = new Set<string>();
  const seenExternalIds = new Set<string>();
  let duplicateExternalIds = 0;
  for (const attempt of audit.firstPassAttempts) {
    const observation = attempt.observation;
    if (!observation || seenUrls.has(observation.sourceReference)) continue;
    seenUrls.add(observation.sourceReference);
    if (observation.externalProductId) {
      if (seenExternalIds.has(observation.externalProductId)) {
        duplicateExternalIds += 1;
        continue;
      }
      seenExternalIds.add(observation.externalProductId);
    }
    observations.push(observation);
  }
  return { observations, duplicateExternalIds };
}

function isOutOfStock(availability: string | null): boolean {
  return Boolean(availability && /outofstock|soldout|out of stock/i.test(availability));
}

function plannedAction(
  match: ContinenteProductMatch,
  observation: AuchanProductObservation,
): AuchanPlannedProductAction {
  if (match.method === "source_native_inactive") return "review_existing_inactive";
  if (match.level === "ambiguous") return "review_ambiguous";
  if (match.level === "exact" || match.level === "high_confidence") {
    return "use_existing_product";
  }
  return observation.externalProductId ? "create_source_native" : "review_identity";
}

export async function buildAuchanDryRunReport(
  adapter: AuchanAdapter,
  catalogReader: AuchanCatalogReader,
  mappings: ContinenteMappingRepository,
  options: AuchanDryRunOptions = {},
): Promise<AuchanDryRunReport> {
  const pageRequestBudget = Math.min(
    100,
    Math.max(1, Math.floor(options.pageRequestBudget ?? 100)),
  );
  const stabilityReads = Math.min(
    20,
    Math.max(0, Math.floor(options.stabilityReads ?? 20)),
    Math.max(0, pageRequestBudget - 1),
  );
  const firstPassLimit = pageRequestBudget - stabilityReads;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const audit = await adapter.runAudit(pageRequestBudget, stabilityReads, offset);
  const catalog = await catalogReader.loadAllProducts();
  const { observations, duplicateExternalIds } = uniqueObservations(audit);
  const items: AuchanDryRunItem[] = [];

  for (const observation of observations) {
    const match = await matchAuchanProduct(observation, catalog, mappings);
    const priceUsableForProduct =
      (match.level === "exact" || match.level === "high_confidence") &&
      isAuchanPriceValid(observation) &&
      observation.externalProductId !== null &&
      !isOutOfStock(observation.availability);
    items.push({
      observation,
      match,
      plannedProductAction: plannedAction(match, observation),
      priceUsableForProduct,
      // The public price is explicitly only a reference for one postal code.
      // No Auchan store is created and this source is not written to the
      // current RPC, which is authorized for Continente only.
      priceSafeToImport: false,
    });
  }

  const firstPassProducts = audit.firstPassAttempts
    .map((attempt) => attempt.observation)
    .filter((observation): observation is AuchanProductObservation => observation !== null);
  const exact = items.filter((item) => item.match.level === "exact").length;
  const highConfidence = items.filter((item) => item.match.level === "high_confidence").length;
  const ambiguous = items.filter((item) => item.match.level === "ambiguous").length;
  const unmatched = items.filter((item) => item.match.level === "unmatched").length;
  const observationsWithScope = observations.filter((item) => item.priceScopeEvidence).length;

  return {
    execution: "read-only-auchan-dry-run",
    mode: "dry-run",
    sourceType: "auchan",
    priceScope: observations.length > 0 && observationsWithScope === observations.length
      ? "reference_only_2650_435"
      : "unknown_or_mixed",
    writesEnabled: false,
    storeCreationEnabled: false,
    pageRequestBudget,
    firstPassLimit,
    catalogProductsLoaded: catalog.length,
    audit,
    counts: {
      pagesRequested: audit.productPageRequests,
      firstPassPages: audit.firstPassAttempts.length,
      stabilityRereads: audit.stability.attempted,
      productsExtracted: firstPassProducts.length,
      pricesExtracted: observations.filter(isAuchanPriceValid).length,
      validExternalIds: firstPassProducts.filter(
        (observation) => observation.externalProductId !== null,
      ).length,
      skuUrlIdMatches: firstPassProducts.filter(
        (observation) =>
          observation.externalProductId !== null &&
          observation.externalProductId === observation.urlProductId,
      ).length,
      duplicateExternalIds,
      productsWithoutId: firstPassProducts.filter(
        (observation) => observation.externalProductId === null,
      ).length,
      formatsExtracted: observations.filter(
        (observation) =>
          observation.packageQuantity !== null &&
          observation.packageUnit !== null,
      ).length,
      promotionsFound: observations.filter(
        (observation) =>
          observation.promotion !== null || observation.regularPrice !== null,
      ).length,
      barcodesFound: observations.filter((observation) => observation.barcode !== null).length,
      exactMatches: exact,
      highConfidenceMatches: highConfidence,
      ambiguousMatches: ambiguous,
      unmatched,
      sourceNativeCandidates: items.filter(
        (item) => item.plannedProductAction === "create_source_native",
      ).length,
      sourceNativeInactive: items.filter(
        (item) => item.plannedProductAction === "review_existing_inactive",
      ).length,
      pricesUsableForProduct: items.filter((item) => item.priceUsableForProduct).length,
      pricesSafeToImport: 0,
      httpErrors: audit.firstPassAttempts.filter((item) => item.outcome === "http_error").length,
      redirects: audit.firstPassAttempts.filter((item) => item.outcome === "redirect").length,
      invalidPages: audit.firstPassAttempts.filter((item) => item.outcome === "invalid_page").length,
      blockedPages: audit.firstPassAttempts.filter((item) => item.outcome === "blocked").length,
    },
    items,
  };
}