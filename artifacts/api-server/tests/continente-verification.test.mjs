import assert from "node:assert/strict";
import test from "node:test";
import { verifyContinenteSnapshot } from "../scripts/continente-verification-core.mjs";

const store = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Continente Online",
  active: true,
  store_type: "online",
  source_type: "continente",
  external_id: "online",
  district: null,
  municipality: null,
  parish: null,
  latitude: null,
  longitude: null,
  address: null,
};
const product = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Produto Continente",
  active: true,
  source_type: "continente",
  external_id: "123",
};
const mapping = {
  source_type: "continente",
  external_product_id: "123",
  product_id: product.id,
  match_method: "source_native",
  confidence: 1,
  verified: true,
};
const price = {
  product_id: product.id,
  store_id: store.id,
  price: "1.19",
  currency: "EUR",
  captured_at: "2026-10-03T14:00:00.000Z",
  valid_from: "2026-10-03T14:00:00.000Z",
  valid_until: "2026-10-05T02:00:00.000Z",
  source_type: "continente",
  external_id: "online:123",
  verification_status: "verified",
};
const history = [{
  product_id: product.id,
  store_id: store.id,
  price: "1.19",
  captured_at: "2026-10-03T14:00:00.000Z",
}];

test("verifica relações e validade sem assumir dimensão fixa do lote", () => {
  const report = verifyContinenteSnapshot({
    sourceProducts: [product],
    mappedProducts: [product],
    mappings: [mapping],
    prices: [price],
    onlineStores: [store],
    history,
  });
  assert.equal(report.ok, true, report.errors.join("; "));
  assert.equal(report.counts.mappings, 1);
  assert.equal(report.counts.prices, 1);
  assert.equal(report.counts.historyEntriesForMappedOnlineProducts, 1);
  assert.equal(report.duplicates.total, 0);
});

test("deteta contrato inválido, divergência e identidades duplicadas", () => {
  const report = verifyContinenteSnapshot({
    sourceProducts: [product, product],
    mappedProducts: [product],
    mappings: [mapping, mapping],
    prices: [{ ...price, currency: "USD" }, { ...price, external_id: "online:other" }],
    onlineStores: [{ ...store, municipality: "Lisboa" }],
    history: [],
  });
  assert.equal(report.ok, false);
  assert.ok(report.duplicates.total > 0);
  assert.ok(report.errors.length > 0);
  assert.equal(report.checks.storeIsOnlineAndUnlocated, false);
});

test("falha explicitamente quando não encontra lote ou loja online", () => {
  const report = verifyContinenteSnapshot({
    sourceProducts: [],
    mappedProducts: [],
    mappings: [],
    prices: [],
    onlineStores: [],
    history: [],
  });
  assert.equal(report.ok, false);
  assert.equal(report.counts.mappings, 0);
  assert.equal(report.checks.noDuplicates, true);
});