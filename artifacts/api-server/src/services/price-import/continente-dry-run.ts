import { ContinenteAdapter } from "./continente-adapter.js";
import { isContinentePriceValid } from "./continente-parser.js";
import { matchContinenteProduct } from "./continente-matcher.js";
import type {
  ContinenteAdapterAudit,
  ContinenteCatalogProduct,
  ContinenteDryRunItem,
  ContinenteDryRunReport,
  ContinenteMappingRepository,
  ContinenteProductObservation,
} from "./continente-types.js";

export interface ContinenteCatalogReader {
  loadActiveProducts(): Promise<ContinenteCatalogProduct[]>;
}

export interface ContinenteDryRunOptions {
  readonly limit?: number;
  readonly stabilityReads?: number;
  readonly offset?: number;
}

function uniqueObservations(audit: ContinenteAdapterAudit): {
  readonly observations: ContinenteProductObservation[];
  readonly duplicateExternalIds: number;
} {
  const observations: ContinenteProductObservation[] = [];
  const seenUrls = new Set<string>();
  const seenExternalIds = new Set<string>();
  let duplicateExternalIds = 0;
  for (const attempt of audit.firstPassAttempts) {
    const observation = attempt.observation;
    if (!observation) continue;
    if (seenUrls.has(observation.sourceReference)) continue;
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

function hasOutOfStockFlag(availability: string | null): boolean {
  return Boolean(availability && /outofstock|soldout|out of stock/i.test(availability));
}

export async function buildContinenteDryRunReport(
  adapter: ContinenteAdapter,
  catalogReader: ContinenteCatalogReader,
  mappings: ContinenteMappingRepository,
  options: ContinenteDryRunOptions = {},
): Promise<ContinenteDryRunReport> {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 200)));
  const stabilityReads = Math.min(20, Math.max(0, Math.floor(options.stabilityReads ?? 20)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const audit = await adapter.runAudit(limit, stabilityReads, offset);
  const catalog = await catalogReader.loadActiveProducts();
  const { observations, duplicateExternalIds } = uniqueObservations(audit);
  const items: ContinenteDryRunItem[] = [];
  for (const observation of observations) {
    const match = await matchContinenteProduct(observation, catalog, mappings);
    const priceUsableForProduct =
      (match.level === "exact" || match.level === "high_confidence") &&
      isContinentePriceValid(observation) &&
      !hasOutOfStockFlag(observation.availability);
    items.push({
      observation,
      match,
      priceUsableForProduct,
      // The current Cabaz comparison path is store-based; an online price has
      // no safe store_id and cannot be inserted into that path as-is.
      priceFeedableToCurrentStoreSchema: false,
    });
  }

  const firstPassProducts = audit.firstPassAttempts
    .map((attempt) => attempt.observation)
    .filter((observation): observation is ContinenteProductObservation => observation !== null);
  const exact = items.filter((item) => item.match.level === "exact").length;
  const highConfidence = items.filter(
    (item) => item.match.level === "high_confidence",
  ).length;
  const ambiguous = items.filter((item) => item.match.level === "ambiguous").length;
  const unmatched = items.filter((item) => item.match.level === "unmatched").length;
  const firstPassPages = audit.firstPassAttempts.length;
  const productsExtracted = firstPassProducts.length;
  const stabilityRereads = audit.stability.attempted;

  return {
    mode: "dry-run",
    sourceType: "continente",
    priceScope: "online",
    writesEnabled: false,
    itemLimit: limit,
    catalogProductsLoaded: catalog.length,
    audit,
    counts: {
      pagesRequested: firstPassPages + stabilityRereads,
      productPagesRequested: firstPassPages,
      stabilityRereads,
      productsExtracted,
      pricesExtracted: observations.filter(isContinentePriceValid).length,
      validExternalIds: firstPassProducts.filter(
        (observation) => observation.externalProductId !== null,
      ).length,
      skuMpnEqual: firstPassProducts.filter(
        (observation) =>
          observation.sku !== null &&
          observation.mpn !== null &&
          observation.sku === observation.mpn,
      ).length,
      urlIdMatches: firstPassProducts.filter(
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
          observation.promotion !== null ||
          observation.regularPrice !== null,
      ).length,
      barcodesFound: observations.filter((observation) => observation.barcode !== null).length,
      exact,
      highConfidence,
      ambiguous,
      unmatched,
      pricesWithUsableProduct: items.filter((item) => item.priceUsableForProduct).length,
      pricesFeedableToCurrentSchema: 0,
      httpErrors: audit.firstPassAttempts.filter(
        (attempt) => attempt.outcome === "http_error",
      ).length,
      redirects: audit.firstPassAttempts.filter(
        (attempt) => attempt.outcome === "redirect",
      ).length,
      invalidPages: audit.firstPassAttempts.filter(
        (attempt) => attempt.outcome === "invalid_page",
      ).length,
    },
    items,
  };
}