import { runPriceImportDryRun } from "./services/price-import/dry-run.js";
import { OpenPricesAdapter } from "./services/price-import/open-prices-adapter.js";
import { SupabasePriceImportLookup } from "./services/price-import/supabase-lookup.js";
import { createSupabaseRestReadClient } from "./services/price-import/supabase-read.js";
import type {
  PriceImportLookup,
  ProductLookupCandidate,
  StoreMappingCandidate,
} from "./services/price-import/types.js";

function memoizeLookup(lookup: PriceImportLookup): PriceImportLookup {
  const productResults = new Map<string, Promise<readonly ProductLookupCandidate[]>>();
  const storeResults = new Map<
    string,
    Promise<readonly StoreMappingCandidate[]>
  >();

  return {
    findActiveProductsByExactBarcode(barcode) {
      let result = productResults.get(barcode);
      if (!result) {
        result = lookup.findActiveProductsByExactBarcode(barcode);
        productResults.set(barcode, result);
      }
      return result;
    },
    findStoresByExternalId(sourceType, externalStoreId) {
      const key = JSON.stringify([sourceType, externalStoreId]);
      let result = storeResults.get(key);
      if (!result) {
        result = lookup.findStoresByExternalId(sourceType, externalStoreId);
        storeResults.set(key, result);
      }
      return result;
    },
  };
}

async function main(): Promise<void> {
  const client = createSupabaseRestReadClient();
  const lookup = memoizeLookup(new SupabasePriceImportLookup(client));
  const source = new OpenPricesAdapter();
  const report = await runPriceImportDryRun(source, lookup);
  const freshnessCounts = {
    "0-3-days": 0,
    "4-7-days": 0,
    "8-30-days": 0,
    "over-30-days": 0,
    unknown: 0,
  };
  const pendingReasonCounts: Record<string, number> = {};
  for (const item of report.items) {
    if (item.freshnessBucket) freshnessCounts[item.freshnessBucket] += 1;
    else freshnessCounts.unknown += 1;
    if (item.status === "pending") {
      for (const reason of item.reasons) {
        pendingReasonCounts[reason] = (pendingReasonCounts[reason] ?? 0) + 1;
      }
    }
  }
  const productIds = new Set(
    report.items.flatMap((item) => item.productId ? [item.productId] : []),
  );
  const storeIds = new Set(
    report.items.flatMap((item) => item.storeId ? [item.storeId] : []),
  );
  const productMatched = report.items.filter(
    (item) => item.productId !== undefined,
  ).length;
  const storeMatched = report.items.filter(
    (item) => item.storeId !== undefined,
  ).length;
  const completeMatchCount = report.items.filter(
    (item) => item.productId !== undefined && item.storeId !== undefined,
  ).length;
  const categorizedPendingReasons = new Set([
    "product_not_found",
    "store_mapping_not_found",
    "store_mapping_unverified",
    "stale_price",
  ]);
  const pendingOtherReasonCount = Object.entries(pendingReasonCounts)
    .filter(([reason]) => !categorizedPendingReasons.has(reason))
    .reduce((total, [, count]) => total + count, 0);

  const summary = {
    execution: "read-only-open-prices-dry-run",
    endpoint: "https://prices.openfoodfacts.org/api/v1",
    sourceType: report.sourceType,
    filters: {
      countryCode: "PT",
      currency: "EUR",
      productPricesOnly: true,
      orderBy: ["date desc", "created desc"],
      maxObservations: 100,
    },
    mode: report.mode,
    sourceMode: report.sourceMode,
    writesEnabled: report.writesEnabled,
    validityPolicy: {
      windowDays: source.validityWindowDays,
      origin: "policy",
      description: "Local Cabaz eligibility window; not supplied by Open Prices.",
    },
    totalFetched: report.items.length,
    counts: report.counts,
    productMatched,
    storeMatched,
    fullyMatched: completeMatchCount,
    uniqueProductsMatched: productIds.size,
    uniqueStoresMatched: storeIds.size,
    pendingByCategory: {
      productNotFound: pendingReasonCounts.product_not_found ?? 0,
      storeNotFound: pendingReasonCounts.store_mapping_not_found ?? 0,
      osmMappingUnverified: pendingReasonCounts.store_mapping_unverified ?? 0,
      stalePrice: pendingReasonCounts.stale_price ?? 0,
      other: pendingOtherReasonCount,
    },
    pendingReasonCounts,
    freshnessCounts,
    currentCount: report.items.filter((item) => item.isCurrent === true).length,
    validUntilMissingCount: report.items.filter((item) => item.validUntilMissing).length,
    unverifiedStoreMappingCount: report.items.filter(
      (item) => item.storeMappingUnverified,
    ).length,
    sample: report.items.slice(0, 5).map((item) => ({
      externalId: item.externalId,
      barcode: item.barcode,
      externalStoreId: item.externalStoreId,
      storeMappingUnverified: item.storeMappingUnverified,
      sourceStoreOsmType: item.sourceStoreOsmType,
      sourceStoreOsmId: item.sourceStoreOsmId,
      priceCents: item.priceCents,
      currency: item.currency,
      capturedAt: item.capturedAt,
      validUntil: item.validUntil,
      validUntilOrigin: item.validUntilOrigin,
      freshnessBucket: item.freshnessBucket,
      isCurrent: item.isCurrent,
      validUntilMissing: item.validUntilMissing,
      status: item.status,
      reasons: item.reasons,
      testOnly: item.testOnly,
    })),
    databaseWrites: {
      "public.prices": 0,
      "public.price_history": 0,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    report.mode !== "dry-run" ||
    report.sourceMode !== "external" ||
    report.writesEnabled !== false ||
    report.items.length > 100 ||
    report.items.some((item) => item.testOnly)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Falha inesperada no dry run Open Prices.";
  console.error(`Dry run Open Prices interrompido: ${message}`);
  process.exitCode = 1;
});