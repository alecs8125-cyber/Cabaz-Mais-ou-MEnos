import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBarcode,
  runPriceImportDryRun,
} from "../tmp/price-import-test-build/services/price-import/index.js";

const validObservation = (overrides = {}) => ({
  sourceType: "test.mock",
  externalId: "test-price-001",
  sourceReference: "local:test/fixture/1",
  barcode: "0005601234567",
  storeSourceType: "openstreetmap",
  externalStoreId: "test-store-01",
  price: "1.23",
  currency: "EUR",
  promotion: null,
  capturedAt: "2026-10-02T12:00:00.000Z",
  validFrom: "2026-10-02T00:00:00.000Z",
  validUntil: "2026-10-03T00:00:00.000Z",
  ...overrides,
});

const testSource = (observations, overrides = {}) => ({
  sourceType: "test.mock",
  mode: "test",
  requiresValidUntil: true,
  async fetchObservations() {
    return observations;
  },
  ...overrides,
});

function testLookup({
  products = [{ id: "product-1", barcode: "0005601234567", active: true }],
  stores = [{
    storeId: "store-1",
    sourceType: "openstreetmap",
    externalStoreId: "test-store-01",
    active: true,
  }],
} = {}) {
  const queries = { products: [], stores: [] };
  return {
    queries,
    async findActiveProductsByExactBarcode(barcode) {
      queries.products.push(barcode);
      return products.filter((product) => product.barcode === barcode);
    },
    async findStoresByExternalId(sourceType, externalStoreId) {
      queries.stores.push([sourceType, externalStoreId]);
      return stores.filter((store) =>
        store.sourceType === sourceType &&
        store.externalStoreId === externalStoreId
      );
    },
  };
}

test("normaliza barcode como texto e preserva zeros à esquerda", () => {
  assert.equal(normalizeBarcode(" 0005601234567 "), "0005601234567");
  assert.equal(normalizeBarcode(5601234567), null);
  assert.equal(normalizeBarcode("   "), null);
});

test("barcode exato encontra produto ativo e não corresponde a um prefixo", async () => {
  const lookup = testLookup({
    products: [
      { id: "prefix", barcode: "5601234567", active: true },
      { id: "inactive", barcode: "0005601234567", active: false },
      { id: "exact", barcode: "0005601234567", active: true },
    ],
  });
  const report = await runPriceImportDryRun(
    testSource([validObservation({ barcode: " 0005601234567 " })]),
    lookup,
  );

  assert.equal(report.items[0].status, "ready");
  assert.equal(report.items[0].productId, "exact");
  assert.deepEqual(lookup.queries.products, ["0005601234567"]);
});

test("barcode desconhecido fica pending", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ barcode: "0000000000000" })]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "pending");
  assert.ok(report.items[0].reasons.includes("product_not_found"));
});

test("loja desconhecida fica pending", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ externalStoreId: "unknown-store" })]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "pending");
  assert.ok(report.items[0].reasons.includes("store_mapping_not_found"));
});

test("preços zero e negativos são rejected", async (t) => {
  for (const price of ["0", "-1.00"]) {
    await t.test(`price=${price}`, async () => {
      const report = await runPriceImportDryRun(
        testSource([validObservation({ price })]),
        testLookup(),
      );
      assert.equal(report.items[0].status, "rejected");
      assert.ok(report.items[0].reasons.includes("price_invalid"));
    });
  }
});

test("moeda diferente de EUR é rejected", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ currency: "USD" })]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "rejected");
  assert.ok(report.items[0].reasons.includes("currency_not_eur"));
});

test("data inválida é rejected", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ capturedAt: "not-a-date" })]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "rejected");
  assert.ok(report.items[0].reasons.includes("captured_at_invalid"));
});

test("valid_until finito é obrigatório quando a fonte assim o exige", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ validUntil: null })]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "rejected");
  assert.ok(report.items[0].reasons.includes("valid_until_required"));
});

test("preço válido com produto e loja identificados fica ready", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation()]),
    testLookup(),
  );

  assert.equal(report.items[0].status, "ready");
  assert.equal(report.items[0].priceCents, 123);
  assert.equal(report.items[0].productId, "product-1");
  assert.equal(report.items[0].storeId, "store-1");
  assert.equal(report.items[0].sourceReference, "local:test/fixture/1");
  assert.equal(report.items[0].storeSourceType, "openstreetmap");
  assert.equal(report.items[0].currency, "EUR");
  assert.equal(report.items[0].capturedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(report.items[0].validUntil, "2026-10-03T00:00:00.000Z");
  assert.equal(report.items[0].validUntilMissing, false);
  assert.equal(report.counts.ready, 1);
});

test("validade ausente fica pending e nunca ready quando a fonte não a fornece", async () => {
  const report = await runPriceImportDryRun(
    testSource([validObservation({ validUntil: null })], {
      requiresValidUntil: false,
    }),
    testLookup(),
    new Date("2026-10-02T12:00:00.000Z"),
  );

  assert.equal(report.items[0].status, "pending");
  assert.equal(report.items[0].validUntilMissing, true);
  assert.ok(report.items[0].reasons.includes("valid_until_missing"));
});

test("não inventa external_id quando o tipo OSM não tem mapeamento verificado", async () => {
  const lookup = testLookup();
  const report = await runPriceImportDryRun(
    testSource([
      validObservation({
        externalStoreId: null,
        storeMappingUnverified: true,
        sourceStoreOsmType: "WAY",
        sourceStoreOsmId: "456",
      }),
    ], { requiresValidUntil: false }),
    lookup,
  );

  assert.equal(report.items[0].status, "pending");
  assert.equal(report.items[0].externalStoreId, null);
  assert.equal(report.items[0].storeMappingUnverified, true);
  assert.equal(report.items[0].sourceStoreOsmType, "WAY");
  assert.equal(report.items[0].sourceStoreOsmId, "456");
  assert.ok(report.items[0].reasons.includes("store_mapping_unverified"));
  assert.deepEqual(lookup.queries.stores, []);
});

test("classifica frescura por intervalos exatos de tempo", async () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const cases = [
    { daysAgo: 0, bucket: "0-3-days", isCurrent: true },
    { daysAgo: 3 + 1 / 86_400_000, bucket: "4-7-days", isCurrent: true },
    { daysAgo: 4, bucket: "4-7-days", isCurrent: true },
    { daysAgo: 7 + 1 / 86_400_000, bucket: "8-30-days", isCurrent: false },
    { daysAgo: 8, bucket: "8-30-days", isCurrent: false },
    { daysAgo: 30 + 1 / 86_400_000, bucket: "over-30-days", isCurrent: false },
    { daysAgo: 31, bucket: "over-30-days", isCurrent: false },
  ];

  for (const freshness of cases) {
    const capturedAt = new Date(now.getTime() - freshness.daysAgo * 86_400_000);
    const report = await runPriceImportDryRun(
      testSource([validObservation({ capturedAt: capturedAt.toISOString() })]),
      testLookup(),
      now,
    );
    assert.equal(report.items[0].freshnessBucket, freshness.bucket);
    assert.equal(report.items[0].isCurrent, freshness.isCurrent);
  }
});

test("Open Prices deriva validade local de 7 dias e mantém o limite exato elegível", async () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const capturedAt = new Date(now.getTime() - 7 * 86_400_000);
  const source = testSource(
    [validObservation({ capturedAt: capturedAt.toISOString(), validUntil: null })],
    { validityWindowDays: 7, requiresValidUntil: false },
  );
  const report = await runPriceImportDryRun(source, testLookup(), now);

  assert.equal(report.items[0].validUntil, now.toISOString());
  assert.equal(report.items[0].validUntilOrigin, "policy");
  assert.equal(report.items[0].validUntilMissing, false);
  assert.equal(report.items[0].isCurrent, true);
  assert.equal(report.items[0].status, "ready");
  assert.deepEqual(report.items[0].reasons, []);
});

test("Open Prices torna a observação pending stale_price após 7 dias e 1 ms", async () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const capturedAt = new Date(now.getTime() - 7 * 86_400_000 - 1);
  const source = testSource(
    [validObservation({ capturedAt: capturedAt.toISOString(), validUntil: null })],
    { validityWindowDays: 7, requiresValidUntil: false },
  );
  const report = await runPriceImportDryRun(source, testLookup(), now);

  assert.equal(report.items[0].validUntil, "2026-10-02T11:59:59.999Z");
  assert.equal(report.items[0].validUntilOrigin, "policy");
  assert.equal(report.items[0].freshnessBucket, "8-30-days");
  assert.equal(report.items[0].isCurrent, false);
  assert.equal(report.items[0].status, "pending");
  assert.ok(report.items[0].reasons.includes("stale_price"));
});

test("preserva metadados de desconto quando estão presentes", async () => {
  const report = await runPriceImportDryRun(
    testSource([
      validObservation({
        priceIsDiscounted: true,
        priceWithoutDiscount: "1.99",
      }),
    ]),
    testLookup(),
  );

  assert.equal(report.items[0].priceIsDiscounted, true);
  assert.equal(report.items[0].priceWithoutDiscount, "1.99");
});

test("fonte mock fica marcada como teste e o relatório não habilita escritas", async () => {
  let attemptedWrites = 0;
  const source = testSource([validObservation()], {
    async writePrices() {
      attemptedWrites += 1;
    },
    async writePriceHistory() {
      attemptedWrites += 1;
    },
  });
  const report = await runPriceImportDryRun(source, testLookup());

  assert.equal(report.mode, "dry-run");
  assert.equal(report.sourceMode, "test");
  assert.equal(report.items[0].testOnly, true);
  assert.equal(report.writesEnabled, false);
  assert.equal(attemptedWrites, 0);
});