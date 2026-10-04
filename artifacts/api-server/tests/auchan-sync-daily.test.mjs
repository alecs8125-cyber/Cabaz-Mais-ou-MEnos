import assert from "node:assert/strict";
import test from "node:test";
import {
  runAuchanDailySync,
} from "../tmp/price-import-test-build/services/price-import/auchan-sync-daily.js";

const NOW = "2026-10-04T10:00:00.000Z";
const STORE_ID = "1fb7c654-65df-48e0-9615-95d0d5cba800";
const PRODUCT_ID = "a5a2c1d2-0000-4000-8000-000000000001";

function observation(id, overrides = {}) {
  return {
    sourceType: "auchan",
    externalProductId: id,
    externalProductIdReason: null,
    sourceReference: `https://www.auchan.pt/pt/alimentacao/produto/${id}.html`,
    name: `PRODUTO ${id}`,
    brand: null,
    barcode: null,
    sku: id,
    urlProductId: id,
    price: "2.35",
    currency: "EUR",
    regularPrice: null,
    promotion: null,
    packageQuantity: null,
    packageUnit: null,
    availability: "InStock",
    image: null,
    capturedAt: NOW,
    priceScope: "reference_only_2650_435",
    priceScopeEvidence: true,
    ...overrides,
  };
}

function attempt(id, overrides = {}) {
  return {
    url: `https://www.auchan.pt/pt/alimentacao/produto/${id}.html`,
    outcome: "product",
    status: 200,
    redirectLocation: null,
    observation: observation(id, overrides),
    error: null,
  };
}

function batchFor(ids, { selectedUrls, offset = 0, nextOffset = offset + selectedUrls.length, totalUrls = nextOffset, skippedKnown = 0 } = {}) {
  const attempts = ids.map((id) => attempt(id));
  return {
    requestedUrls: attempts.map(({ url }) => url),
    firstPassAttempts: attempts,
    stability: {
      target: ids.length,
      attempted: ids.length,
      stable: ids.length,
      changed: 0,
      failed: 0,
      details: attempts.map(({ url, observation: item }) => ({
        url,
        firstExternalProductId: item.externalProductId,
        secondExternalProductId: item.externalProductId,
        stable: true,
      })),
    },
    stoppedReason: null,
    productPageRequests: ids.length * 2,
    sitemapUrl: "https://www.auchan.pt/sitemap_0-product.xml",
    offset,
    nextOffset,
    totalUrls,
    selectedUrls,
    skippedKnown,
  };
}

function checkpoint(metadata, updatedAt = NOW) {
  return {
    source_type: "auchan",
    cursor_value: metadata.phase,
    last_attempt_at: NOW,
    last_success_at: NOW,
    last_error: null,
    metadata,
    updated_at: updatedAt,
  };
}

function makeMetadata({ phase = "discovery", refresh, discovery, status = "complete" } = {}) {
  return {
    dailySyncVersion: 1,
    phase,
    refresh: refresh ?? {
      day: "2026-10-04",
      queue: [],
      cursor: 0,
      complete: true,
    },
    discovery: discovery ?? {
      sitemapIndexUrl: "https://www.auchan.pt/sitemap_index.xml",
      sitemapManifestHash: null,
      sitemapIndex: 0,
      sitemapUrl: "https://www.auchan.pt/sitemap_0-product.xml",
      offset: 0,
      lastProductUrl: null,
      cycle: 0,
      cycleComplete: false,
    },
    run: { id: "previous-run", status, startedAt: NOW, lock: null },
  };
}

function makeRepository({
  commitEnabled = false,
  candidates = [],
  savedCheckpoint = null,
} = {}) {
  const state = {
    checkpoint: savedCheckpoint,
    candidates: [...candidates],
    products: [],
    mappings: [],
    price: null,
    historyAt: null,
    historyPrice: null,
    rpcCalls: [],
    checkpointWrites: [],
    checkpointReads: 0,
    updatedAtCounter: 0,
  };
  const store = { id: STORE_ID, name: "Auchan Online · referência 2650-435 (Amadora)" };
  const repository = {
    commitEnabled,
    state,
    preflight: async () => ({
      blockers: [],
      referenceStore: store,
      mappingsAvailable: true,
      capabilities: {
        productIdentityUnique: true,
        storeIdentityUnique: true,
        priceIdentityUnique: true,
        referenceStoreExists: true,
      },
    }),
    preflightDailySync: async () => [],
    loadDailyCheckpoint: async () => {
      state.checkpointReads += 1;
      return state.checkpoint;
    },
    insertDailyCheckpoint: async (fields) => {
      assert.equal(fields.source_type, "auchan");
      if (state.checkpoint) throw new Error("duplicate checkpoint");
      state.updatedAtCounter += 1;
      state.checkpoint = {
        ...fields,
        updated_at: new Date(Date.parse(NOW) + state.updatedAtCounter).toISOString(),
      };
      state.checkpointWrites.push(["insert", fields]);
      return state.checkpoint;
    },
    updateDailyCheckpoint: async (expectedUpdatedAt, fields) => {
      assert.equal(fields.source_type, "auchan");
      assert.equal(state.checkpoint?.updated_at, expectedUpdatedAt);
      state.updatedAtCounter += 1;
      state.checkpoint = {
        ...fields,
        updated_at: new Date(Date.parse(NOW) + state.updatedAtCounter).toISOString(),
      };
      state.checkpointWrites.push(["update", fields]);
      return state.checkpoint;
    },
    loadDailyPriceCandidates: async (storeId) => {
      assert.equal(storeId, STORE_ID);
      return state.candidates;
    },
    findMappings: async (sku) => state.mappings.filter(
      (item) => item.externalProductId === sku,
    ),
    findSourceProducts: async (sku) => state.products.filter(
      (item) => item.externalId === sku,
    ),
    findProduct: async (id) => state.products.find((item) => item.id === id) ?? null,
    createNative: async (fields) => {
      const product = {
        id: PRODUCT_ID,
        name: fields.name,
        brand: fields.brand,
        barcode: fields.barcode,
        unit: fields.unit,
        active: true,
        sourceType: fields.source_type,
        externalId: fields.external_id,
      };
      state.products.push(product);
      return { product, inserted: true };
    },
    createMapping: async (fields) => {
      state.mappings.push({
        sourceType: fields.source_type,
        externalProductId: fields.external_product_id,
        productId: fields.product_id,
        matchMethod: fields.match_method,
        confidence: fields.confidence,
        verified: fields.verified,
      });
      return true;
    },
    findLatestReferencePrice: async () => state.price,
    upsertReferencePrice: async (args) => {
      state.rpcCalls.push(args);
      const price = Number(args.p_price).toFixed(2);
      const changed = state.price?.price !== price;
      state.price = {
        id: "price-row",
        productId: args.p_product_id,
        storeId: STORE_ID,
        price,
        currency: "EUR",
        capturedAt: args.p_captured_at,
        validUntil: new Date(Date.parse(args.p_captured_at) + 36 * 60 * 60 * 1000).toISOString(),
        sourceType: "auchan",
        sourceReference: args.p_source_reference,
        verificationStatus: "verified",
      };
      if (changed) {
        state.historyAt = args.p_captured_at;
        state.historyPrice = price;
      }
      return { id: "price-row" };
    },
    findReferencePrice: async (_productId, _storeId, sourceReference, capturedAt) =>
      state.price?.sourceReference === sourceReference &&
      state.price?.capturedAt === capturedAt
        ? state.price
        : null,
    hasReferencePriceHistory: async (_productId, _storeId, price, capturedAt) =>
      state.historyAt === capturedAt && state.historyPrice === price,
  };
  return repository;
}

function makeAdapter({
  productIds = [],
  pageBatch,
  sitemapBatch,
  plan = {
    robotsUrl: "https://www.auchan.pt/robots.txt",
    sitemapIndexUrl: "https://www.auchan.pt/sitemap_index.xml",
    productSitemaps: ["https://www.auchan.pt/sitemap_0-product.xml"],
  },
} = {}) {
  const calls = { productUrls: [], sitemapBatches: [], discovery: 0 };
  return {
    calls,
    discoverProductSitemaps: async () => {
      calls.discovery += 1;
      return plan;
    },
    runProductUrls: async (urls, stabilityReads) => {
      calls.productUrls.push({ urls: [...urls], stabilityReads });
      return pageBatch ?? batchFor(
        productIds.length ? productIds : urls.map((url) => /\/(\d+)\.html$/.exec(url)?.[1]),
        { selectedUrls: [...urls] },
      );
    },
    runSitemapBatch: async (...args) => {
      calls.sitemapBatches.push(args);
      return sitemapBatch ?? batchFor(productIds, {
        selectedUrls: productIds.map((id) =>
          `https://www.auchan.pt/pt/alimentacao/produto/${id}.html`
        ),
        offset: args[1],
        nextOffset: args[1] + productIds.length,
        totalUrls: args[1] + productIds.length,
      });
    },
  };
}

const emptyCatalog = { loadAllProducts: async () => [] };
const emptyMappings = { findMappings: async () => [] };
const dependencies = {
  now: () => new Date(NOW),
  createRunId: () => "run-test",
};

test("Auchan daily refresca primeiro o preço mais próximo da expiração", async () => {
  const candidates = [
    {
      sku: "1663",
      sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1663.html",
      capturedAt: "2026-10-03T10:00:00.000Z",
      validUntil: "2026-10-05T10:00:00.000Z",
      price: "2.35",
      productId: PRODUCT_ID,
    },
    {
      sku: "1662",
      sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
      capturedAt: "2026-10-02T10:00:00.000Z",
      validUntil: "2026-10-04T11:00:00.000Z",
      price: "2.35",
      productId: PRODUCT_ID,
    },
  ];
  const repository = makeRepository({ candidates });
  const adapter = makeAdapter({ productIds: ["1662"] });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: false, commit: false },
    dependencies,
  );
  assert.equal(report.ok, true);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.counts.refreshQueued, 2);
  assert.equal(report.counts.refreshProcessed, 1);
  assert.deepEqual(adapter.calls.productUrls[0].urls, [candidates[1].sourceReference]);
  assert.equal(adapter.calls.discovery, 0);
  assert.equal(repository.state.checkpointWrites.length, 0);
  assert.equal(repository.state.rpcCalls.length, 0);
});

test("Auchan daily retoma o cursor persistido sem offset manual", async () => {
  const metadata = makeMetadata({
    phase: "refresh",
    refresh: {
      day: "2026-10-04",
      queue: [
        {
          sku: "1662",
          sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
        },
        {
          sku: "1663",
          sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1663.html",
        },
      ],
      cursor: 1,
      complete: false,
    },
  });
  const repository = makeRepository({
    savedCheckpoint: checkpoint(metadata),
    candidates: [],
  });
  const adapter = makeAdapter({ productIds: ["1663"] });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: true, commit: false },
    dependencies,
  );
  assert.equal(report.ok, true);
  assert.equal(repository.state.checkpointReads, 1);
  assert.deepEqual(adapter.calls.productUrls[0].urls, [
    "https://www.auchan.pt/pt/alimentacao/produto/1663.html",
  ]);
  assert.equal(report.checkpointBefore.cycle, 0);
  assert.equal(repository.state.checkpointWrites.length, 0);
});

test("Auchan discovery retoma pelo último URL guardado e avança o bookmark", async () => {
  const previousUrl = "https://www.auchan.pt/pt/alimentacao/produto/1662.html";
  const nextUrl = "https://www.auchan.pt/pt/alimentacao/produto/1663.html";
  const metadata = makeMetadata({
    phase: "discovery",
    discovery: {
      sitemapIndexUrl: "https://www.auchan.pt/sitemap_index.xml",
      sitemapManifestHash: null,
      sitemapIndex: 0,
      sitemapUrl: "https://www.auchan.pt/sitemap_0-product.xml",
      offset: 1,
      lastProductUrl: previousUrl,
      cycle: 2,
      cycleComplete: false,
    },
  });
  const repository = makeRepository({ savedCheckpoint: checkpoint(metadata) });
  const adapter = makeAdapter({
    sitemapBatch: batchFor(["1663"], {
      selectedUrls: [nextUrl],
      offset: 2,
      nextOffset: 3,
      totalUrls: 5,
    }),
  });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: true, commit: false },
    dependencies,
  );
  assert.equal(report.ok, true);
  assert.equal(adapter.calls.sitemapBatches.length, 1);
  assert.equal(adapter.calls.sitemapBatches[0][6], previousUrl);
  assert.equal(report.checkpointBefore.cycle, 2);
  assert.equal(report.checkpointAfter.offset, 3);
  assert.equal(repository.state.checkpointWrites.length, 0);
});

test("Auchan avança o bookmark ao ignorar entradas de sitemap sem produto", async () => {
  const productUrl = "https://www.auchan.pt/pt/alimentacao/produto/1662.html";
  const metadata = makeMetadata({ phase: "discovery" });
  const repository = makeRepository({ savedCheckpoint: checkpoint(metadata) });
  const invalidBatch = batchFor([], {
    selectedUrls: [productUrl],
    offset: 0,
    nextOffset: 1,
    totalUrls: 2,
  });
  invalidBatch.requestedUrls = [productUrl];
  invalidBatch.firstPassAttempts = [{
    url: productUrl,
    outcome: "invalid_page",
    status: 200,
    redirectLocation: null,
    observation: null,
    error: "product_schema_missing",
  }];
  invalidBatch.stability = {
    target: 1,
    attempted: 0,
    stable: 0,
    changed: 0,
    failed: 0,
    details: [],
  };
  invalidBatch.productPageRequests = 1;
  const adapter = makeAdapter({ sitemapBatch: invalidBatch });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: true, commit: false },
    dependencies,
  );
  assert.equal(report.ok, true);
  assert.equal(report.counts.unavailable, 1);
  assert.equal(report.counts.pricesEligible, 0);
  assert.equal(report.checkpointAfter.offset, 1);
});

test("Auchan daily commit grava só pelo RPC e checkpoint source_type=auchan", async () => {
  const repository = makeRepository({ commitEnabled: true });
  const productUrl = "https://www.auchan.pt/pt/alimentacao/produto/1662.html";
  const adapter = makeAdapter({
    productIds: ["1662"],
    sitemapBatch: batchFor(["1662"], {
      selectedUrls: [productUrl],
      offset: 0,
      nextOffset: 1,
      totalUrls: 1,
    }),
  });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: true, commit: true },
    dependencies,
  );
  assert.equal(report.ok, true);
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.counts.pricesCreated, 1);
  assert.equal(report.counts.historyCreatedConfirmed, 1);
  assert.equal(repository.state.rpcCalls.length, 1);
  assert.equal(repository.state.checkpoint.source_type, "auchan");
  assert.ok(repository.state.checkpointWrites.length >= 2);
  assert.equal(repository.state.rpcCalls[0].p_external_product_id, "1662");
  assert.equal(repository.state.rpcCalls[0].p_price, 2.35);
});

test("Auchan daily commit recusa execução sem resume antes de qualquer escrita", async () => {
  const repository = makeRepository({ commitEnabled: true });
  const adapter = makeAdapter({ productIds: ["1662"] });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    emptyCatalog,
    emptyMappings,
    { limit: 1, resume: false, commit: true },
    dependencies,
  );
  assert.equal(report.ok, false);
  assert.match(report.errors[0], /require --resume/i);
  assert.equal(adapter.calls.productUrls.length, 0);
  assert.equal(repository.state.checkpointWrites.length, 0);
  assert.equal(repository.state.rpcCalls.length, 0);
});
