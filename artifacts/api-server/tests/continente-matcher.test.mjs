import assert from "node:assert/strict";
import test from "node:test";
import {
  matchContinenteProduct,
} from "../tmp/price-import-test-build/services/price-import/continente-matcher.js";
import {
  buildContinenteDryRunReport,
} from "../tmp/price-import-test-build/services/price-import/continente-dry-run.js";
import {
  NoPersistedContinenteMappings,
} from "../tmp/price-import-test-build/services/price-import/supabase-continente-catalog.js";

const observation = (overrides = {}) => ({
  sourceType: "continente",
  externalProductId: "2597619",
  externalProductIdReason: null,
  sourceReference: "https://www.continente.pt/produto/banana-2597619.html",
  name: "Banana Continente",
  brand: "Continente",
  barcode: null,
  sku: "2597619",
  mpn: "2597619",
  urlProductId: "2597619",
  price: "1.29",
  currency: "EUR",
  promotion: null,
  regularPrice: null,
  packageQuantity: null,
  packageUnit: null,
  availability: "https://schema.org/InStock",
  image: null,
  pricePerUnit: null,
  capturedAt: "2026-10-03T12:00:00.000Z",
  priceScope: "online",
  ...overrides,
});

const catalogProduct = (overrides = {}) => ({
  id: "catalog-1",
  name: "Banana",
  brand: "Continente",
  barcode: null,
  unit: "kg",
  active: true,
  ...overrides,
});

test("barcode exato tem prioridade e associa um único produto ativo", async () => {
  const result = await matchContinenteProduct(
    observation({ barcode: "4006381333931" }),
    [
      catalogProduct({ id: "inactive", barcode: "4006381333931", active: false }),
      catalogProduct({ id: "exact", barcode: "4006381333931" }),
    ],
    new NoPersistedContinenteMappings(),
  );

  assert.equal(result.level, "exact");
  assert.equal(result.method, "barcode_exact");
  assert.equal(result.product.id, "exact");
});

test("nome completo normalizado e marca únicos produzem high-confidence", async () => {
  const result = await matchContinenteProduct(
    observation(),
    [catalogProduct()],
    new NoPersistedContinenteMappings(),
  );

  assert.equal(result.level, "high_confidence");
  assert.equal(result.method, "name_brand_exact_unique");
  assert.equal(result.candidateCount, 1);
  assert.match(result.explanation, /exactly and uniquely/);
});

test("candidatos ambíguos nunca recebem product_id", async () => {
  const result = await matchContinenteProduct(
    observation(),
    [
      catalogProduct({ id: "one" }),
      catalogProduct({ id: "two" }),
    ],
    new NoPersistedContinenteMappings(),
  );

  assert.equal(result.level, "ambiguous");
  assert.equal(result.product, null);
  assert.equal(result.candidateCount, 2);
});

test("nomes apenas semelhantes ficam unmatched", async () => {
  const result = await matchContinenteProduct(
    observation(),
    [catalogProduct({ name: "Bananas maduras Continente" })],
    new NoPersistedContinenteMappings(),
  );

  assert.equal(result.level, "unmatched");
  assert.equal(result.product, null);
});

test("mapping verificado é consultado antes do barcode", async () => {
  const mappingRepository = {
    async findMappings(sourceType, externalProductId) {
      assert.equal(sourceType, "continente");
      assert.equal(externalProductId, "2597619");
      return [{
        sourceType: "continente",
        externalProductId: "2597619",
        productId: "mapped",
        matchMethod: "manual_verified",
        confidence: 1,
        verified: true,
      }];
    },
  };
  const result = await matchContinenteProduct(
    observation({ barcode: "4006381333931" }),
    [
      catalogProduct({ id: "barcode", barcode: "4006381333931" }),
      catalogProduct({ id: "mapped", name: "Outro produto" }),
    ],
    mappingRepository,
  );

  assert.equal(result.level, "exact");
  assert.equal(result.method, "verified_external_mapping");
  assert.equal(result.product.id, "mapped");
});

test("IDs externos repetidos são contados mas não duplicam itens do dry run", async () => {
  const first = observation();
  const second = observation({
    sourceReference: "https://www.continente.pt/produto/banana-variante-2597619.html",
    price: "1.39",
  });
  const audit = {
    robotsUrl: "https://www.continente.pt/robots.txt",
    robotsAllowsProductPages: true,
    sitemapIndexUrl: "https://www.continente.pt/sitemap_index.xml",
    productSitemaps: ["https://www.continente.pt/sitemap-product.xml"],
    sampledSitemapUrl: "https://www.continente.pt/sitemap-product.xml",
    sampledSitemapUrlCount: 2,
    sampledProductUrls: [first.sourceReference, second.sourceReference],
    firstPassAttempts: [
      { url: first.sourceReference, outcome: "product", status: 200, redirectLocation: null, observation: first, error: null },
      { url: second.sourceReference, outcome: "product", status: 200, redirectLocation: null, observation: second, error: null },
    ],
    stability: { target: 0, attempted: 0, stable: 0, changed: 0, failed: 0, details: [] },
    stoppedReason: null,
  };
  const report = await buildContinenteDryRunReport(
    { async runAudit() { return audit; } },
    { async loadActiveProducts() { return [catalogProduct()]; } },
    new NoPersistedContinenteMappings(),
    { limit: 2, stabilityReads: 0 },
  );

  assert.equal(report.counts.productsExtracted, 2);
  assert.equal(report.counts.duplicateExternalIds, 1);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].match.level, "high_confidence");
  assert.equal(report.items[0].priceFeedableToCurrentStoreSchema, false);
  assert.equal(report.counts.pricesFeedableToCurrentSchema, 0);
});