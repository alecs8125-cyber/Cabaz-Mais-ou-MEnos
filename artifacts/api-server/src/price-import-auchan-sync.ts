import { AuchanAdapter } from "./services/price-import/auchan-adapter.js";
import { buildAuchanDryRunReport } from "./services/price-import/auchan-dry-run.js";
import { SupabaseContinenteProductCatalog } from "./services/price-import/supabase-continente-catalog.js";
import {
  createSupabaseAuchanReadClient,
  SupabaseAuchanMappingRepository,
} from "./services/price-import/supabase-auchan-read.js";
import { syncAuchanObservations } from "./services/price-import/auchan-sync.js";
import { SupabaseAuchanSyncRepository } from "./services/price-import/supabase-auchan-sync-repository.js";

function readIntegerArgument(
  args: readonly string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const argument = args.find((value) => value.startsWith(`--${name}=`));
  if (!argument) return fallback;
  const value = Number(argument.slice(name.length + 3));
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function safeItemsSummary(report: Awaited<ReturnType<typeof buildAuchanDryRunReport>>) {
  return report.items.map((item) => ({
    sku: item.observation.externalProductId,
    name: item.observation.name,
    action: item.plannedProductAction,
    matchMethod: item.match.method,
    identityStable: item.identityStable,
    price: item.observation.price,
    priceScope: item.observation.priceScope,
    priceSafeToImport: item.priceSafeToImport,
    importBlockers: item.importBlockers,
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commitEnabled = args.includes("--commit");
  const pageRequestBudget = readIntegerArgument(args, "limit", 50, 1, 100);
  const stabilityReads = readIntegerArgument(args, "stability-reads", 20, 0, 20);
  const offset = readIntegerArgument(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (commitEnabled && (pageRequestBudget < 45 || pageRequestBudget > 60 || stabilityReads !== 20)) {
    throw new Error(
      "Commit requires --limit=45..60 and --stability-reads=20 (at most 40 sampled products plus 20 stability reads).",
    );
  }

  const repository = new SupabaseAuchanSyncRepository(commitEnabled);
  const preflight = await repository.preflight();
  if (preflight.blockers.length) {
    console.log(JSON.stringify({
      execution: commitEnabled ? "auchan-commit-blocked" : "auchan-dry-run-blocked",
      mode: commitEnabled ? "commit" : "dry-run",
      preflight,
      pagesRequested: 0,
      writes: 0,
      sqlExecuted: false,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const clock = () => new Date();
  const adapter = new AuchanAdapter({
    maxProductPageRequests: pageRequestBudget,
    now: clock,
  });
  const readClient = createSupabaseAuchanReadClient();
  const dryRun = await buildAuchanDryRunReport(
    adapter,
    new SupabaseContinenteProductCatalog(readClient),
    new SupabaseAuchanMappingRepository(readClient),
    {
      pageRequestBudget,
      stabilityReads,
      offset,
      now: clock,
    },
  );
  const safeItems = dryRun.items
    .filter((item) => item.priceSafeToImport && item.identityStable)
    .slice(0, 20);

  const healthBlockers: string[] = [];
  if (commitEnabled) {
    if (dryRun.audit.stoppedReason) healthBlockers.push(dryRun.audit.stoppedReason);
    if (dryRun.audit.firstPassAttempts.length < 20) {
      healthBlockers.push("Fewer than 20 first-pass product-page requests completed.");
    }
    if (
      dryRun.audit.stability.target !== 20 ||
      dryRun.audit.stability.stable !== 20 ||
      dryRun.audit.stability.changed !== 0 ||
      dryRun.audit.stability.failed !== 0
    ) healthBlockers.push("All 20 product IDs must remain stable on a repeated GET.");
    if (dryRun.priceScope !== "reference_only_2650_435") {
      healthBlockers.push("Every extracted product page must prove the 2650-435 Amadora reference scope.");
    }
    if (
      dryRun.counts.productsExtracted < 20 ||
      dryRun.counts.validExternalIds < 20 ||
      dryRun.counts.skuUrlIdMatches < 20 ||
      dryRun.counts.duplicateExternalIds !== 0
    ) healthBlockers.push("The sampled products do not contain 20 unique, URL-matching Auchan identities.");
    if (
      dryRun.counts.httpErrors > 0 ||
      dryRun.counts.redirects > 0 ||
      dryRun.counts.blockedPages > 0
    ) healthBlockers.push("The sample contains an HTTP error, redirect, or blocked product page.");
    if (safeItems.length === 0) {
      healthBlockers.push("No fresh, available product has a safely importable EUR reference price.");
    }
  }

  if (healthBlockers.length) {
    console.log(JSON.stringify({
      execution: "auchan-commit-blocked",
      mode: "commit",
      preflight,
      healthBlockers,
      dryRun: {
        priceScope: dryRun.priceScope,
        counts: dryRun.counts,
        stableIds: dryRun.audit.stability,
        products: safeItemsSummary(dryRun),
      },
      writes: 0,
      sqlExecuted: false,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const sync = await syncAuchanObservations(safeItems, repository, clock());
  console.log(JSON.stringify({
    execution: commitEnabled ? "auchan-bounded-commit" : "auchan-read-only-dry-run",
    mode: sync.mode,
    writesEnabled: sync.writesEnabled,
    preflight,
    websitePolicy: {
      priceScope: dryRun.priceScope,
      label: "Auchan Online · referência 2650-435 (Amadora)",
      note: "Prices remain references for postal code 2650-435 in Amadora; they are not national or physical-store prices.",
    },
    requestPolicy: {
      method: "GET only for Auchan pages and all preflight reads",
      commit: commitEnabled ? "explicit --commit; at most 20 products" : "disabled by default",
      productPageRequestBudget: pageRequestBudget,
      productPagesRequested: dryRun.counts.pagesRequested,
      stabilityRereads: dryRun.audit.stability.attempted,
      sqlExecuted: false,
      storeCreationAllowed: false,
      schedulerConfigured: false,
    },
    dryRun: {
      counts: dryRun.counts,
      stableIds: dryRun.audit.stability,
      products: safeItemsSummary(dryRun),
    },
    sync,
    writes: commitEnabled
      ? sync.counts.sourceNativeCreated + sync.counts.mappingsCreated + sync.counts.pricesWritten
      : 0,
  }, null, 2));

  if (
    (commitEnabled && sync.blockers.length > 0) ||
    (commitEnabled && sync.counts.errors > 0) ||
    (commitEnabled && sync.counts.pricesWritten !== safeItems.length)
  ) process.exitCode = 2;
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Unexpected Auchan sync error.";
  console.error(`Auchan sync stopped before further writes: ${message}`);
  process.exitCode = 1;
});