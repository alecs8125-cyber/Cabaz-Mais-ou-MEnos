import { ContinenteAdapter } from "./services/price-import/continente-adapter.js";
import {
  buildContinenteDryRunReport,
} from "./services/price-import/continente-dry-run.js";
import {
  NoPersistedContinenteMappings,
  SupabaseContinenteProductCatalog,
} from "./services/price-import/supabase-continente-catalog.js";
import {
  createSupabaseRestReadClient,
} from "./services/price-import/supabase-read.js";

function readLimit(args: readonly string[]): number {
  const argument = args.find((value) => value.startsWith("--limit="));
  if (!argument) return 200;
  const value = Number(argument.slice("--limit=".length));
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("--limit must be an integer between 1 and 200.");
  }
  return value;
}

function readOffset(args: readonly string[]): number {
  const argument = args.find((value) => value.startsWith("--offset="));
  if (!argument) return 0;
  const value = Number(argument.slice("--offset=".length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("--offset must be a non-negative safe integer.");
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = readLimit(args);
  const offset = readOffset(args);
  const client = createSupabaseRestReadClient();
  const report = await buildContinenteDryRunReport(
    new ContinenteAdapter(),
    new SupabaseContinenteProductCatalog(client),
    new NoPersistedContinenteMappings(),
    { limit, stabilityReads: 20, offset },
  );
  const examples = report.items
    .filter((item) =>
      item.match.level === "exact" || item.match.level === "high_confidence"
    )
    .slice(0, 10)
    .map((item) => ({
      continente: {
        name: item.observation.name,
        brand: item.observation.brand,
        price: item.observation.price,
        currency: item.observation.currency,
        external_product_id: item.observation.externalProductId,
      },
      catalog: {
        product_id: item.match.product?.id ?? null,
        name: item.match.product?.name ?? null,
        brand: item.match.product?.brand ?? null,
      },
      level: item.match.level,
      method: item.match.method,
      confidence: item.match.confidence,
      explanation: item.match.explanation,
    }));

  const networkErrors = report.audit.firstPassAttempts.filter(
    (attempt) => attempt.outcome === "network_error",
  ).length;
  console.log(JSON.stringify({
    mode: report.mode,
    sourceType: report.sourceType,
    priceScope: report.priceScope,
    writesEnabled: report.writesEnabled,
    itemLimit: report.itemLimit,
    catalogProductsLoaded: report.catalogProductsLoaded,
    sitemap: {
      robotsUrl: report.audit.robotsUrl,
      robotsAllowsProductPages: report.audit.robotsAllowsProductPages,
      sitemapIndexUrl: report.audit.sitemapIndexUrl,
      productSitemapsDiscovered: report.audit.productSitemaps.length,
      productSitemapsRead: report.audit.productSitemapsRead,
      sampledSitemapUrl: report.audit.sampledSitemapUrl,
      productUrlsScanned: report.audit.productUrlsScanned,
      startOffset: report.audit.startOffset,
      uniqueProductUrlsSelected: report.audit.sampledProductUrls.length,
    },
    counts: { ...report.counts, networkErrors },
    externalIdentity: {
      chosenSourceType: "continente",
      chosenExternalProductId: "JSON-LD sku = JSON-LD mpn = numeric product URL suffix",
      validIds: report.counts.validExternalIds,
      skuMpnEqual: report.counts.skuMpnEqual,
      urlIdMatches: report.counts.urlIdMatches,
      duplicateIds: report.counts.duplicateExternalIds,
      productsWithoutId: report.counts.productsWithoutId,
      stability: {
        target: report.audit.stability.target,
        attempted: report.audit.stability.attempted,
        stable: report.audit.stability.stable,
        changed: report.audit.stability.changed,
        failed: report.audit.stability.failed,
      },
    },
    examples,
    currentStoreSchemaCanAcceptOnlinePrices: false,
    stoppedReason: report.audit.stoppedReason,
    noWritesConfirmedByImplementation: true,
  }, null, 2));

  if (
    report.audit.stoppedReason ||
    report.audit.stability.attempted < report.audit.stability.target
  ) {
    process.exitCode = 2;
  }
}

main().catch((cause) => {
  console.error(
    cause instanceof Error ? cause.message : "Continente dry run failed.",
  );
  process.exitCode = 1;
});