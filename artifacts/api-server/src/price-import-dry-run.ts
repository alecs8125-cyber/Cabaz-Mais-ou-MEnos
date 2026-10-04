import {
  runPriceImportDryRun,
} from "./services/price-import/dry-run.js";
import {
  createSupabaseRestReadClient,
} from "./services/price-import/supabase-read.js";
import {
  SupabasePriceImportLookup,
} from "./services/price-import/supabase-lookup.js";
import type {
  ExternalPriceObservation,
  PriceImportSourceAdapter,
  ProductLookupCandidate,
  StoreMappingCandidate,
} from "./services/price-import/types.js";

const STORE_SOURCE_TYPE = "openstreetmap";
const TEST_PRICE = "1.23";

function createTestSource(
  observation: ExternalPriceObservation,
): PriceImportSourceAdapter {
  return {
    sourceType: "test.dry-run",
    mode: "test",
    requiresValidUntil: true,
    async fetchObservations() {
      return [observation];
    },
  };
}

function createTestObservation(
  product: ProductLookupCandidate,
  store: StoreMappingCandidate,
  overrides: Partial<ExternalPriceObservation> = {},
): ExternalPriceObservation {
  const capturedAt = new Date();
  return {
    sourceType: "test.dry-run",
    externalId: "local-dry-run-test-fixture",
    sourceReference: "local:test:price-import-dry-run",
    barcode: product.barcode,
    storeSourceType: store.sourceType,
    externalStoreId: store.externalStoreId,
    price: TEST_PRICE,
    currency: "EUR",
    promotion: null,
    capturedAt: capturedAt.toISOString(),
    validFrom: capturedAt.toISOString(),
    validUntil: new Date(capturedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function findUnusedBarcode(
  lookup: SupabasePriceImportLookup,
): Promise<string> {
  for (const barcode of [
    "0000000000000",
    "9999999999999",
    "8888888888888",
    "7777777777777",
  ]) {
    const matches = await lookup.findActiveProductsByExactBarcode(barcode);
    if (matches.length === 0) return barcode;
  }
  throw new Error("Não foi possível encontrar um barcode de teste inexistente.");
}

async function findUnusedStoreId(
  lookup: SupabasePriceImportLookup,
): Promise<string> {
  for (const externalStoreId of [
    "__dry_run_missing_store__",
    "__dry_run_missing_store_2__",
    "__dry_run_missing_store_3__",
  ]) {
    const matches = await lookup.findStoresByExternalId(
      STORE_SOURCE_TYPE,
      externalStoreId,
    );
    if (matches.length === 0) return externalStoreId;
  }
  throw new Error("Não foi possível encontrar um identificador de loja inexistente.");
}

function maskedExternalId(value: string): string {
  return `<texto mascarado; ${value.length} caracteres>`;
}

async function main(): Promise<void> {
  const client = createSupabaseRestReadClient();
  const lookup = new SupabasePriceImportLookup(client);

  const product = await lookup.findFirstActiveProductWithBarcode();
  if (!product) {
    throw new Error("Não foi encontrado um produto ativo com barcode de texto.");
  }

  const store = await lookup.findFirstActiveStoreWithExternalId(STORE_SOURCE_TYPE);
  if (!store) {
    throw new Error(
      `Não foi encontrada uma loja ativa com source_type=${STORE_SOURCE_TYPE} e external_id textual.`,
    );
  }

  const observation = createTestObservation(product, store);
  const source = createTestSource(observation);
  const readyReport = await runPriceImportDryRun(source, lookup);

  const missingBarcode = await findUnusedBarcode(lookup);
  const missingBarcodeReport = await runPriceImportDryRun(
    createTestSource(createTestObservation(product, store, { barcode: missingBarcode })),
    lookup,
  );

  const missingStoreId = await findUnusedStoreId(lookup);
  const missingStoreReport = await runPriceImportDryRun(
    createTestSource(
      createTestObservation(product, store, { externalStoreId: missingStoreId }),
    ),
    lookup,
  );

  const readyItem = readyReport.items[0];
  const missingBarcodeItem = missingBarcodeReport.items[0];
  const missingStoreItem = missingStoreReport.items[0];
  const summary = {
    execution: "real-supabase-read-only-dry-run",
    storeExample: {
      source_type: store.sourceType,
      external_id: {
        type: "string",
        example: maskedExternalId(store.externalStoreId),
      },
    },
    productLookup: {
      foundActiveProductWithTextBarcode: true,
      resolvedByExactBarcode: readyItem?.status === "ready",
    },
    storeLookup: {
      foundActiveStoreWithExternalId: true,
      resolvedByExactSourceTypeAndExternalId: readyItem?.status === "ready",
    },
    testRecord: {
      mode: "test",
      sourceType: source.sourceType,
      price: TEST_PRICE,
      currency: "EUR",
      markedTestOnly: readyItem?.testOnly === true,
    },
    dryRun: {
      mode: readyReport.mode,
      sourceMode: readyReport.sourceMode,
      writesEnabled: readyReport.writesEnabled,
      counts: readyReport.counts,
      itemStatus: readyItem?.status ?? "missing",
    },
    negativeCases: {
      unknownBarcode: {
        status: missingBarcodeItem?.status ?? "missing",
        reasons: missingBarcodeItem?.reasons ?? [],
      },
      unknownStore: {
        status: missingStoreItem?.status ?? "missing",
        reasons: missingStoreItem?.reasons ?? [],
      },
    },
    databaseWrites: {
      "public.prices": 0,
      "public.price_history": 0,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    readyItem?.status !== "ready" ||
    readyReport.writesEnabled !== false ||
    readyReport.sourceMode !== "test" ||
    readyItem.testOnly !== true ||
    missingBarcodeItem?.status !== "pending" ||
    !missingBarcodeItem.reasons.includes("product_not_found") ||
    missingStoreItem?.status !== "pending" ||
    !missingStoreItem.reasons.includes("store_mapping_not_found")
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Falha inesperada no dry run.";
  console.error(`Dry run interrompido: ${message}`);
  process.exitCode = 1;
});