import { AuchanAdapter } from "./services/price-import/auchan-adapter.js";
import { buildAuchanDryRunReport } from "./services/price-import/auchan-dry-run.js";
import { SupabaseContinenteProductCatalog } from "./services/price-import/supabase-continente-catalog.js";
import {
  createSupabaseAuchanReadClient,
  SupabaseAuchanMappingRepository,
} from "./services/price-import/supabase-auchan-read.js";

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  products: ["id", "name", "brand", "barcode", "unit", "active", "source_type", "external_id"],
  stores: ["id", "name", "active", "store_type", "source_type", "external_id"],
  external_product_mappings: [
    "source_type",
    "external_product_id",
    "product_id",
    "match_method",
    "confidence",
    "verified",
  ],
  prices: [
    "product_id",
    "store_id",
    "captured_at",
    "valid_from",
    "valid_until",
    "source_type",
    "external_id",
    "source_reference",
  ],
  price_history: ["product_id", "store_id", "price", "captured_at"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

async function inspectSchema(client: ReturnType<typeof createSupabaseAuchanReadClient>) {
  const schema = await client.getOpenApiSchema();
  const definitions = isRecord(schema.definitions) ? schema.definitions : {};
  const paths = isRecord(schema.paths) ? schema.paths : {};
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    const definition = definitions[table];
    const properties = isRecord(definition) && isRecord(definition.properties)
      ? definition.properties
      : null;
    if (!properties) {
      missing.push(`public.${table}`);
      continue;
    }
    for (const column of columns) {
      if (!Object.hasOwn(properties, column)) missing.push(`public.${table}.${column}`);
    }
  }
  const rpc = paths["/rpc/upsert_verified_price_with_history"];
  const rpcPost = isRecord(rpc) && isRecord(rpc.post) ? rpc.post : null;
  const rpcParameters = rpcPost && Array.isArray(rpcPost.parameters)
    ? rpcPost.parameters
    : [];
  const body = rpcParameters.find((parameter) =>
    isRecord(parameter) && parameter.in === "body"
  );
  const rpcBody = isRecord(body) && isRecord(body.schema) && isRecord(body.schema.properties)
    ? Object.keys(body.schema.properties)
    : [];
  const requiredRpcArguments = [
    "p_product_id",
    "p_store_id",
    "p_price",
    "p_currency",
    "p_captured_at",
    "p_valid_from",
    "p_valid_until",
    "p_source_type",
    "p_external_id",
    "p_source_reference",
    "p_promotion",
  ];
  if (!rpcPost) missing.push("public.upsert_verified_price_with_history");
  else if (requiredRpcArguments.some((argument) => !rpcBody.includes(argument))) {
    missing.push("public.upsert_verified_price_with_history parameter contract");
  }
  return {
    requiredTablesAndColumnsPresent: missing.length === 0,
    missing,
    priceRpcPresent: Boolean(rpcPost),
    priceRpcParameters: rpcBody.sort(),
    priceRpcSupportsAuchan: false,
    priceRpcNotCalled: true,
    auchanIdentityIndexesVerified: false,
    note: "The repository's current RPC migration authorizes Continente only; OpenAPI does not prove Auchan-specific uniqueness or execution policy.",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pageRequestBudget = readIntegerArgument(args, "limit", 100, 1, 100);
  const stabilityReads = readIntegerArgument(args, "stability-reads", 20, 0, 20);
  const offset = readIntegerArgument(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const client = createSupabaseAuchanReadClient();
  const schema = await inspectSchema(client);
  if (!schema.requiredTablesAndColumnsPresent) {
    throw new Error(
      `Read-only schema audit failed: ${schema.missing.join(", ")}. No Auchan product pages were requested.`,
    );
  }

  const adapter = new AuchanAdapter({ maxProductPageRequests: pageRequestBudget });
  const report = await buildAuchanDryRunReport(
    adapter,
    new SupabaseContinenteProductCatalog(client),
    new SupabaseAuchanMappingRepository(client),
    { pageRequestBudget, stabilityReads, offset },
  );
  const [mappings, stores, prices] = await Promise.all([
    client.getRows("external_product_mappings", {
      select: "source_type,external_product_id",
      source_type: "eq.auchan",
      limit: "2",
    }),
    client.getRows("stores", {
      select: "id,name,active,store_type,source_type,external_id",
      source_type: "eq.auchan",
      external_id: "eq.online",
      limit: "2",
    }),
    client.getRows("prices", {
      select: "id,source_type,external_id,store_id,product_id",
      source_type: "eq.auchan",
      limit: "2",
    }),
  ]);
  const sample = report.items.slice(0, 20).map((item) => ({
    name: item.observation.name,
    brand: item.observation.brand,
    sourceType: item.observation.sourceType,
    sku: item.observation.sku,
    externalProductId: item.observation.externalProductId,
    urlProductId: item.observation.urlProductId,
    barcode: item.observation.barcode,
    package: {
      quantity: item.observation.packageQuantity,
      unit: item.observation.packageUnit,
    },
    price: item.observation.price,
    currency: item.observation.currency,
    capturedAt: item.observation.capturedAt,
    validFromCandidate: item.observation.capturedAt,
    validUntilCandidate: Number.isFinite(Date.parse(item.observation.capturedAt))
      ? new Date(Date.parse(item.observation.capturedAt) + 36 * 60 * 60 * 1000).toISOString()
      : null,
    regularPrice: item.observation.regularPrice,
    promotion: item.observation.promotion,
    availability: item.observation.availability,
    priceScope: item.observation.priceScope,
    match: {
      level: item.match.level,
      method: item.match.method,
      candidateCount: item.match.candidateCount,
      productId: item.match.product?.id ?? null,
      explanation: item.match.explanation,
    },
    plannedProductAction: item.plannedProductAction,
    priceUsableForProduct: item.priceUsableForProduct,
    priceSafeToImport: item.priceSafeToImport,
  }));
  const stability = report.audit.stability;
  const firstPassIdMatches = report.audit.firstPassAttempts.filter(
    (attempt) =>
      attempt.observation?.externalProductId !== null &&
      attempt.observation?.externalProductId !== undefined &&
      attempt.observation?.externalProductId === attempt.observation?.urlProductId,
  ).length;

  console.log(JSON.stringify({
    execution: report.execution,
    mode: report.mode,
    sourceType: report.sourceType,
    externalIdentity: {
      field: "JSON-LD sku",
      requiredCheck: "sku must equal the numeric ID at the end of the canonical product URL",
      verifiedInFirstPass: firstPassIdMatches,
      stableOnRepeatedGet: stability.stable,
      repeatAttempts: stability.attempted,
      changed: stability.changed,
      failed: stability.failed,
      examples: stability.details.slice(0, 5),
    },
    websitePolicy: {
      publicPriceScope: report.priceScope,
      text: "Pre-login prices are reference prices for delivery/collection at postal code 2650-435 Amadora; after login they depend on the serving store and postal code.",
      observedOnProductPages: report.counts.productsExtracted,
      storeCreationAllowed: false,
      pricesSafeToImport: false,
    },
    proposedPriceValidity: {
      capturedAt: "collection instant",
      validFrom: "equal to capturedAt",
      validUntil: "36 hours after capturedAt",
      timezone: "Europe/Lisbon",
      verificationStatus: "not marked verified; no price records were written",
    },
    requestPolicy: {
      method: "GET only",
      cookiesOrLogin: false,
      cartOrAccountRequests: false,
      browserOrCaptchaWorkarounds: false,
      concurrency: 1,
      productPageRequestBudget: pageRequestBudget,
      requestDelayMs: 1000,
      productPagesRequested: report.counts.pagesRequested,
      noSqlOrMutations: true,
    },
    sitemap: {
      robotsAllowsProductPages: report.audit.robotsAllowsProductPages,
      sitemapIndexUrl: report.audit.sitemapIndexUrl,
      productSitemapsDiscovered: report.audit.productSitemaps.length,
      productSitemapsRead: report.audit.productSitemapsRead,
      sampledSitemapUrl: report.audit.sampledSitemapUrl,
      productUrlsScanned: report.audit.productUrlsScanned,
      selectedDistinctUrls: report.audit.sampledProductUrls.length,
    },
    liveDatabaseReadOnlyAudit: {
      schema,
      catalogProductsLoaded: report.catalogProductsLoaded,
      auchanMappingRowsReturned: mappings.length,
      auchanOnlineStoreRowsReturned: stores.length,
      auchanPriceRowsReturned: prices.length,
      serviceRoleUsedForGetOnlyReads: true,
      writes: 0,
      rpcCalls: 0,
      sqlExecuted: false,
    },
    writesEnabled: report.writesEnabled,
    storeCreationEnabled: report.storeCreationEnabled,
    matchingOrder: [
      "verified existing external_product_mappings row",
      "existing source-native Auchan product",
      "exact GTIN/barcode",
      "unique exact normalized name and brand",
      "otherwise create a source-native product candidate (dry-run only)",
    ],
    counts: {
      ...report.counts,
      stabilityTarget: stability.target,
      stableIdsRequired: 20,
      stableIdThresholdMet: stability.stable >= 20,
    },
    importBlockers: [
      "Public pre-login prices are only references for postal code 2650-435, not a proven global Auchan Online price.",
      "No Auchan Online store or current Auchan price rows exist.",
      "The existing repository RPC is authorized for Continente only; Auchan idempotency/unique indexes are not verified.",
    ],
    sample,
    stoppedReason: report.audit.stoppedReason,
    noWritesConfirmedByImplementation: true,
  }, null, 2));

  if (
    report.audit.stoppedReason ||
    report.audit.stability.stable < Math.min(20, stabilityReads) ||
    report.counts.pagesRequested > pageRequestBudget
  ) process.exitCode = 2;
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Auchan dry run failed.";
  console.error(`Auchan read-only dry run stopped: ${message}`);
  process.exitCode = 1;
});