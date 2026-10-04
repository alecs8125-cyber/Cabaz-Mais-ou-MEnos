import assert from "node:assert/strict";
import test from "node:test";
import {
  parseContinenteDailyOptions,
} from "../tmp/price-import-test-build/services/price-import/continente-sync-daily-options.js";
import {
  runContinenteDailySync,
} from "../tmp/price-import-test-build/services/price-import/continente-sync-daily.js";

const now = new Date("2026-10-03T12:00:00.000Z");
const sitemapUrl = "https://www.continente.pt/sitemap-product.xml";
const urls = [
  "https://www.continente.pt/produto/item-10001.html",
  "https://www.continente.pt/produto/item-10002.html",
  "https://www.continente.pt/produto/item-10003.html",
];
const noStability = { target: 0, attempted: 0, stable: 0, changed: 0, failed: 0, details: [] };

function redirectAttempt(url) {
  return {
    url,
    outcome: "redirect",
    status: 302,
    redirectLocation: "https://www.continente.pt/",
    observation: null,
    error: "unsafe_redirect_not_followed",
  };
}

class FakeRepository {
  constructor(commitEnabled, checkpoint = null) {
    this.commitEnabled = commitEnabled;
    this.checkpoint = checkpoint;
    this.writes = [];
    this.version = 0;
    this.priceCandidates = [];
  }
  async preflight() { return { blockers: [], mappingsAvailable: true }; }
  async preflightDailySync() { return []; }
  async loadDailyCheckpoint() { return this.checkpoint; }
  async insertDailyCheckpoint(fields) {
    this.writes.push("insert");
    this.checkpoint = { ...fields, updated_at: `2026-10-03T12:00:0${this.version++}.000Z` };
    return this.checkpoint;
  }
  async updateDailyCheckpoint(_expectedUpdatedAt, fields) {
    this.writes.push("update");
    this.checkpoint = { ...fields, updated_at: `2026-10-03T12:00:0${this.version++}.000Z` };
    return this.checkpoint;
  }
  async findOnlineStore() {
    return { id: "00000000-0000-4000-8000-000000000001", name: "Continente Online" };
  }
  async loadOnlinePriceCandidates() { return this.priceCandidates; }
  async loadOnlinePricesBySkus() { return new Map(); }
  async loadHistoryKeys() { return new Set(); }
}

function fakeAdapter({ blocked = false, observation = null } = {}) {
  const calls = [];
  const productCalls = [];
  return {
    calls,
    productCalls,
    async discoverProductSitemaps() {
      return {
        robotsUrl: "https://www.continente.pt/robots.txt",
        sitemapIndexUrl: "https://www.continente.pt/sitemap_index.xml",
        productSitemaps: [sitemapUrl],
        retries: 0,
      };
    },
    async runProductUrls(requestedUrls) {
      productCalls.push([...requestedUrls]);
      return {
        requestedUrls,
        firstPassAttempts: requestedUrls.map(redirectAttempt),
        stability: noStability,
        stoppedReason: null,
        productPageRequests: requestedUrls.length,
        retries: 0,
      };
    },
    async runSitemapBatch(url, offset, limit, stability, knownIds, maxPages, bookmark) {
      calls.push({ url, offset, limit, stability, knownIds, maxPages, bookmark });
      const selected = urls.slice(offset, offset + Math.min(limit, maxPages));
      const attempts = observation
        ? [{
            url: observation.sourceReference,
            outcome: "product",
            status: 200,
            redirectLocation: null,
            observation,
            error: null,
          }]
        : selected.map(redirectAttempt);
      return {
        sitemapUrl: url,
        offset,
        nextOffset: offset + selected.length,
        totalUrls: urls.length,
        selectedUrls: selected,
        skippedKnown: 0,
        firstPassAttempts: attempts,
        stability: observation
          ? { target: stability, attempted: stability, stable: stability, changed: 0, failed: 0, details: [] }
          : noStability,
        stoppedReason: blocked ? "blocked by source" : null,
        productPageRequests: selected.length,
        retries: 0,
      };
    },
  };
}

class UncertainWriteRepository extends FakeRepository {
  constructor() {
    super(true);
    this.products = [];
    this.mappings = [];
    this.prices = new Map();
    this.history = new Set();
    this.rpcCalls = 0;
  }
  async loadCatalog() { return this.products.filter((product) => product.active); }
  async findMappings(sku) {
    return this.mappings.filter((mapping) => mapping.externalProductId === sku);
  }
  async findSourceProducts(sku) {
    return this.products.filter(
      (product) => product.sourceType === "continente" && product.externalId === sku,
    );
  }
  async findProduct(id) { return this.products.find((product) => product.id === id) ?? null; }
  async createNative(fields) {
    const product = {
      id: "00000000-0000-4000-8000-000000000010",
      name: fields.name,
      brand: fields.brand,
      barcode: fields.barcode,
      unit: fields.unit,
      active: true,
      sourceType: "continente",
      externalId: fields.external_id,
    };
    this.products.push(product);
    return product;
  }
  async updateNative() {}
  async createMapping(fields) {
    this.mappings.push({
      sourceType: fields.source_type,
      externalProductId: fields.external_product_id,
      productId: fields.product_id,
      matchMethod: fields.match_method,
      confidence: fields.confidence,
      verified: fields.verified,
    });
    return true;
  }
  async upsertPrice(args) {
    this.rpcCalls += 1;
    const sku = String(args.p_external_id).slice("online:".length);
    const row = {
      sku,
      sourceReference: args.p_source_reference,
      capturedAt: args.p_captured_at,
      validUntil: args.p_valid_until,
      price: String(args.p_price),
      productId: args.p_product_id,
    };
    this.prices.set(sku, row);
    this.history.add(`${row.productId}|${Number(row.price).toFixed(2)}|${Date.parse(row.capturedAt)}`);
    throw new Error("simulated lost RPC acknowledgement");
  }
  async loadOnlinePricesBySkus(_storeId, skus) {
    return new Map(skus.flatMap((sku) => this.prices.has(sku) ? [[sku, this.prices.get(sku)]] : []));
  }
  async loadHistoryKeys() { return this.history; }
}

const dependencies = {
  now: () => new Date(now),
  createRunId: () => "test-run",
};

test("daily CLI defaults to dry-run and requires --resume for writes", () => {
  assert.deepEqual(parseContinenteDailyOptions([]), {
    limit: 100,
    resume: false,
    commit: false,
  });
  assert.deepEqual(
    parseContinenteDailyOptions(["--limit=100", "--resume", "--commit"]),
    { limit: 100, resume: true, commit: true },
  );
  assert.throws(() => parseContinenteDailyOptions(["--commit"]), /requires --resume/);
  assert.throws(() => parseContinenteDailyOptions(["--limit=101"]), /1 to 100/);
});

test("dry-run reads the sitemap cursor but performs no checkpoint writes", async () => {
  const repository = new FakeRepository(false);
  const adapter = fakeAdapter();
  const report = await runContinenteDailySync(
    { limit: 1, resume: false, commit: false },
    repository,
    adapter,
    dependencies,
  );

  assert.equal(report.ok, true);
  assert.equal(report.writesEnabled, false);
  assert.equal(report.scheduleConfigured, false);
  assert.equal(report.checkpointAfter.offset, 1);
  assert.equal(report.counts.redirects, 1);
  assert.deepEqual(repository.writes, []);
  assert.equal(adapter.calls[0].offset, 0);
});

test("resume uses the last product URL bookmark rather than restarting a sitemap", async () => {
  const checkpoint = {
    source_type: "continente",
    cursor_value: "discovery:0:1",
    last_attempt_at: "2026-10-03T11:00:00.000Z",
    last_success_at: "2026-10-03T11:00:00.000Z",
    last_error: null,
    updated_at: "2026-10-03T11:00:00.000Z",
    metadata: {
      dailySyncVersion: 1,
      phase: "discovery",
      refresh: { day: "2026-10-03", queue: [], cursor: 0, complete: true },
      discovery: {
        sitemapIndexUrl: "https://www.continente.pt/sitemap_index.xml",
        sitemapManifestHash: "old-hash",
        sitemapIndex: 0,
        sitemapUrl,
        offset: 1,
        lastProductUrl: urls[0],
        cycle: 3,
        cycleComplete: false,
      },
      run: { id: "prior", status: "complete", startedAt: "2026-10-03T11:00:00.000Z", lock: null },
    },
  };
  const repository = new FakeRepository(false, checkpoint);
  const adapter = fakeAdapter();
  const report = await runContinenteDailySync(
    { limit: 1, resume: true, commit: false },
    repository,
    adapter,
    dependencies,
  );

  assert.equal(report.ok, true);
  assert.equal(adapter.calls[0].offset, 1);
  assert.equal(adapter.calls[0].bookmark, urls[0]);
  assert.equal(report.checkpointAfter.offset, 2);
  assert.equal(report.checkpointAfter.cycle, 3);
  assert.deepEqual(repository.writes, []);
});

test("commit checkpoints successful sublots and records the Lisbon attempt time", async () => {
  const repository = new FakeRepository(true);
  const adapter = fakeAdapter();
  const report = await runContinenteDailySync(
    { limit: 1, resume: true, commit: true },
    repository,
    adapter,
    dependencies,
  );

  assert.equal(report.ok, true);
  assert.equal(repository.writes[0], "insert");
  assert.ok(repository.writes.filter((entry) => entry === "update").length >= 2);
  assert.equal(repository.checkpoint.last_attempt_at, now.toISOString());
  assert.equal(repository.checkpoint.last_success_at, now.toISOString());
  assert.equal(repository.checkpoint.last_error, null);
  assert.equal(repository.checkpoint.metadata.discovery.offset, 1);
  assert.equal(repository.checkpoint.metadata.run.lock, null);
});

test("refresh backlog continues next day invocation without discarding queued prices", async () => {
  const repository = new FakeRepository(true);
  repository.priceCandidates = [0, 1].map((index) => ({
    sku: String(10001 + index),
    sourceReference: urls[index],
    capturedAt: now.toISOString(),
    validUntil: null,
    price: "2.49",
    productId: `00000000-0000-4000-8000-00000000001${index}`,
  }));
  const firstAdapter = fakeAdapter();
  await runContinenteDailySync(
    { limit: 1, resume: true, commit: true },
    repository,
    firstAdapter,
    dependencies,
  );
  assert.equal(repository.checkpoint.metadata.refresh.cursor, 1);
  assert.equal(repository.checkpoint.metadata.refresh.queue.length, 2);
  assert.equal(repository.checkpoint.metadata.refresh.complete, false);

  const secondAdapter = fakeAdapter();
  const secondReport = await runContinenteDailySync(
    { limit: 1, resume: true, commit: true },
    repository,
    secondAdapter,
    dependencies,
  );
  assert.equal(secondReport.ok, true);
  assert.deepEqual(secondAdapter.productCalls, [[urls[1]]]);
  assert.equal(repository.checkpoint.metadata.refresh.complete, true);
  assert.equal(repository.checkpoint.metadata.refresh.day, "2026-10-03");
});

test("a lost RPC acknowledgement is reconciled by GET before the checkpoint advances", async () => {
  const repository = new UncertainWriteRepository();
  const observation = {
    sourceType: "continente",
    externalProductId: "10001",
    externalProductIdReason: null,
    sourceReference: urls[0],
    name: "Produto teste",
    brand: "Marca",
    barcode: null,
    sku: "10001",
    mpn: "10001",
    urlProductId: "10001",
    price: "2.49",
    currency: "EUR",
    promotion: null,
    regularPrice: null,
    packageQuantity: null,
    packageUnit: null,
    availability: "InStock",
    image: null,
    pricePerUnit: null,
    capturedAt: now.toISOString(),
    priceScope: "online",
  };
  const report = await runContinenteDailySync(
    { limit: 1, resume: true, commit: true },
    repository,
    fakeAdapter({ observation }),
    dependencies,
  );

  assert.equal(report.ok, true);
  assert.equal(repository.rpcCalls, 1);
  assert.equal(report.counts.syncErrorsReconciled, 1);
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.counts.historyCreatedConfirmed, 1);
  assert.equal(repository.checkpoint.metadata.discovery.offset, 1);
});

test("a blocked sublot keeps the previous cursor and releases its checkpoint lease", async () => {
  const repository = new FakeRepository(true);
  const report = await runContinenteDailySync(
    { limit: 1, resume: true, commit: true },
    repository,
    fakeAdapter({ blocked: true }),
    dependencies,
  );

  assert.equal(report.ok, false);
  assert.equal(repository.checkpoint.metadata.discovery.offset, 0);
  assert.equal(repository.checkpoint.metadata.run.lock, null);
  assert.match(repository.checkpoint.last_error, /blocked by source/);
});