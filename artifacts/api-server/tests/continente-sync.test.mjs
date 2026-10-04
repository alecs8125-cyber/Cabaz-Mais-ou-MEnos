import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { syncContinenteObservations, continentePriceArguments } from "../tmp/price-import-test-build/services/price-import/continente-sync.js";
import { SupabaseContinenteSyncRepository, PRICE_RPC_FIELDS } from "../tmp/price-import-test-build/services/price-import/continente-sync-repository.js";
import { parseContinenteSyncOptions } from "../tmp/price-import-test-build/services/price-import/continente-sync-options.js";

const now = new Date("2026-10-03T14:00:00Z");
const observation = (overrides = {}) => ({
  sourceType: "continente", externalProductId: "123", externalProductIdReason: null,
  sourceReference: "https://www.continente.pt/produto/produto-123.html",
  name: "Produto real Marca", brand: "Marca", barcode: null, sku: "123", mpn: "123",
  urlProductId: "123", price: "1.23", currency: "EUR", promotion: null, regularPrice: null,
  packageQuantity: null, packageUnit: null, availability: "InStock", image: "https://www.continente.pt/img.jpg",
  pricePerUnit: null, capturedAt: now.toISOString(), priceScope: "online", ...overrides,
});
const product = (overrides = {}) => ({
  id: "product-existing", name: "Outra coisa", brand: "Marca", barcode: null, unit: null,
  active: true, sourceType: null, externalId: null, ...overrides,
});

// An explicit in-memory test double, never used by the app or live CLI.
class Repository {
  commitEnabled = true;
  blockers = [];
  products = [];
  mappings = [];
  store = null;
  current = new Map();
  history = [];
  writes = [];
  rpcCalls = [];
  async preflight() { return { blockers: this.blockers, mappingsAvailable: true }; }
  async loadCatalog() { return this.products.filter((p) => p.active); }
  async findMappings(sku) { return this.mappings.filter((m) => m.externalProductId === sku); }
  async findSourceProducts(sku) { return this.products.filter((p) => p.sourceType === "continente" && p.externalId === sku); }
  async findProduct(id) { return this.products.find((p) => p.id === id) ?? null; }
  async findOnlineStore() { return this.store; }
  async createOnlineStore() {
    this.writes.push("store");
    this.store = { id: "online", name: "Continente Online" };
    return this.store;
  }
  async createNative(fields) {
    this.writes.push(["product", fields]);
    const row = product({ id: `native-${fields.external_id}`, sourceType: fields.source_type, externalId: fields.external_id, name: fields.name, brand: fields.brand, barcode: fields.barcode, unit: fields.unit });
    this.products.push(row);
    return row;
  }
  async updateNative(id, fields) { this.writes.push(["update", id, fields]); }
  async createMapping(fields) {
    this.writes.push(["mapping", fields]);
    this.mappings.push({ sourceType: fields.source_type, externalProductId: fields.external_product_id, productId: fields.product_id, matchMethod: fields.match_method, confidence: fields.confidence, verified: fields.verified });
    return true;
  }
  async upsertPrice(args) {
    this.writes.push("rpc");
    this.rpcCalls.push(args);
    const previous = this.current.get(args.p_external_id);
    const created = !previous;
    const changed = Boolean(previous && previous.p_price !== args.p_price);
    if (previous && (Date.parse(args.p_captured_at) < Date.parse(previous.p_captured_at) ||
        (args.p_captured_at === previous.p_captured_at && changed))) {
      return { kind: "detailed", price_id: "00000000-0000-4000-8000-000000000001", price_created: false, price_changed: false, history_created: false, stale_observation: true };
    }
    this.current.set(args.p_external_id, args);
    if (created || changed) this.history.push(args);
    return { kind: "detailed", price_id: "00000000-0000-4000-8000-000000000001", price_created: created, price_changed: changed, history_created: created || changed, stale_observation: false };
  }
}

test("source-native sem barcode, categoria ou formato inventados; mapping e RPC online", async () => {
  const repo = new Repository();
  const report = await syncContinenteObservations([observation()], repo, now);
  assert.equal(report.counts.sourceNativeCreated, 1);
  assert.equal(report.counts.mappingsCreated, 1);
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.counts.historyCreated, 1);
  assert.equal(report.onlineStore.name, "Continente Online");
  const fields = repo.writes.find((w) => Array.isArray(w) && w[0] === "product")[1];
  assert.equal(fields.barcode, null);
  assert.equal(fields.category, null);
  assert.equal(fields.unit, null);
  assert.equal(fields.package_quantity, null);
  assert.equal(fields.image_url, "https://www.continente.pt/img.jpg");
  assert.equal(repo.mappings[0].matchMethod, "source_native");
  assert.equal(repo.mappings[0].confidence, 1);
  assert.equal(repo.mappings[0].verified, true);
  assert.equal(repo.rpcCalls[0].p_store_id, "online");
  assert.equal(repo.rpcCalls[0].p_external_id, "online:123");
  assert.equal(repo.rpcCalls[0].p_valid_until, "2026-10-05T02:00:00.000Z");
  assert.deepEqual(Object.keys(repo.rpcCalls[0]).sort(), [...PRICE_RPC_FIELDS].sort());
});

test("idempotência: reutiliza mapping/produto, renova validade e mesmo preço não soma histórico no contrato", async () => {
  const repo = new Repository();
  await syncContinenteObservations([observation()], repo, now);
  const later = new Date(now.getTime() + 3600000);
  const report = await syncContinenteObservations([observation({ capturedAt: later.toISOString(), name: "Nome corrigido Marca" })], repo, later);
  assert.equal(repo.products.length, 1);
  assert.equal(repo.mappings.length, 1);
  assert.equal(report.counts.sourceNativeCreated, 0);
  assert.equal(report.counts.existingReused, 1);
  assert.equal(report.counts.historyCreated, 0);
  assert.equal(repo.history.length, 1);
  assert.equal(repo.rpcCalls[1].p_valid_until, "2026-10-05T03:00:00.000Z");
  assert.ok(repo.writes.some((w) => Array.isArray(w) && w[0] === "update" && w[2].name === "Nome corrigido Marca"));
  const next = new Date(later.getTime() + 3600000);
  const changed = await syncContinenteObservations([observation({ price: "2.00", capturedAt: next.toISOString() })], repo, next);
  assert.equal(changed.counts.historyCreated, 1);
  assert.equal(repo.history.length, 2);
});

test("source_type + external_id tem prioridade sobre barcode ou nome", async () => {
  const repo = new Repository();
  repo.products = [
    product({ id: "native", sourceType: "continente", externalId: "123" }),
    product({ id: "barcode", barcode: "4006381333931" }),
  ];
  const report = await syncContinenteObservations([observation({ barcode: "4006381333931" })], repo, now);
  assert.equal(report.items[0].productId, "native");
  assert.equal(report.items[0].method, "source_native");
});

test("barcode exato pode reutilizar outro SKU nativo e o mapping mantém-se válido", async () => {
  const repo = new Repository();
  repo.products = [product({ id: "same-barcode", sourceType: "continente", externalId: "456", barcode: "4006381333931" })];
  const source = observation({ barcode: "4006381333931" });
  const first = await syncContinenteObservations([source], repo, now);
  const repeated = await syncContinenteObservations([source], repo, now);
  assert.equal(first.items[0].method, "barcode_exact");
  assert.equal(first.items[0].productId, "same-barcode");
  assert.equal(first.counts.sourceNativeCreated, 0);
  assert.equal(repeated.items[0].productId, "same-barcode");
  assert.equal(repeated.counts.errors, 0);
  assert.equal(repo.writes.some((write) => Array.isArray(write) && write[0] === "update"), false);
});

test("mapping verificado existente tem primeira prioridade", async () => {
  const repo = new Repository();
  repo.products = [product({ id: "chosen" })];
  repo.mappings = [{ sourceType: "continente", externalProductId: "123", productId: "chosen", matchMethod: "manual_verified", confidence: 1, verified: true }];
  const report = await syncContinenteObservations([observation()], repo, now);
  assert.equal(report.items[0].productId, "chosen");
  assert.equal(report.counts.mappingsCreated, 0);
});

test("match determinístico único reutilizado, ambíguo cria identidade nativa separada", async () => {
  const exact = new Repository();
  exact.products = [product({ name: "Produto real" })];
  const reused = await syncContinenteObservations([observation()], exact, now);
  assert.equal(reused.items[0].method, "name_brand_exact_unique");
  assert.equal(reused.counts.sourceNativeCreated, 0);
  assert.equal(exact.mappings[0].verified, true);
  const ambiguous = new Repository();
  ambiguous.products = [product({ id: "a", name: "Produto real" }), product({ id: "b", name: "Produto real" })];
  const native = await syncContinenteObservations([observation()], ambiguous, now);
  assert.equal(native.items[0].productId, "native-123");
  assert.equal(native.counts.sourceNativeCreated, 1);
});

test("múltiplos source-native / mappings e mapping conflitante dão erro sem escolher", async () => {
  for (const type of ["source", "mapping", "conflict"]) {
    const repo = new Repository();
    repo.store = { id: "online", name: "Continente Online" };
    if (type === "source") repo.products = ["a", "b"].map((id) => product({ id, sourceType: "continente", externalId: "123" }));
    else {
      repo.products = [product()];
      const mapping = { sourceType: "continente", externalProductId: "123", productId: "product-existing", matchMethod: "manual_verified", confidence: 1, verified: true };
      repo.mappings = type === "mapping" ? [mapping, mapping] : [{ ...mapping, verified: false }];
    }
    const report = await syncContinenteObservations([observation()], repo, now);
    assert.equal(report.counts.errors, 1);
    assert.equal(repo.writes.length, 0);
  }
});

test("dry run planeia source-native mas ZERO chamadas de mutação", async () => {
  const repo = new Repository();
  repo.commitEnabled = false;
  repo.blockers = ["Missing mapping table/RPC."];
  const report = await syncContinenteObservations([observation()], repo, now);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.counts.nativePlanned, 1);
  assert.equal(report.items[0].productId, null);
  assert.equal(repo.writes.length, 0);
});

test("commit bloqueado por preflight antes de qualquer escrita, batch acima de 20 rejeitado", async () => {
  const repo = new Repository();
  repo.blockers = ["RPC missing"];
  await assert.rejects(syncContinenteObservations([observation()], repo, now), /preflight/);
  assert.equal(repo.writes.length, 0);
  await assert.rejects(syncContinenteObservations(Array(21).fill(observation()), repo, now), /safety limit/);
});

test("commit controlado de 20 produtos únicos funciona no repositório isolado", async () => {
  const repo = new Repository();
  const observations = Array.from({ length: 20 }, (_, index) => {
    const sku = String(index + 1);
    return observation({ externalProductId: sku, sku, mpn: sku, urlProductId: sku, sourceReference: `https://www.continente.pt/produto/item-${sku}.html` });
  });
  const report = await syncContinenteObservations(observations, repo, now);
  assert.equal(report.counts.processed, 20);
  assert.equal(report.counts.sourceNativeCreated, 20);
  assert.equal(report.counts.pricesWritten, 20);
  assert.equal(report.counts.pricesWith36h, 20);
  assert.equal(report.counts.errors, 0);
});

test("UUID válido da RPC confirma o preço mas deixa história e validade por confirmar", async () => {
  const repo = new Repository();
  repo.upsertPrice = async () => ({
    kind: "uuid", price_id: "102b2584-b198-4e70-af51-b321eaff1037",
  });
  const report = await syncContinenteObservations([observation()], repo, now);
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.counts.historyCreated, null);
  assert.equal(report.counts.pricesWith36h, null);
  assert.equal(report.counts.errors, 0);
});

test("argumentos RPC: frescura local 36h, negativos/futuro/expirado/indisponível não verificados", () => {
  for (const overrides of [
    { price: "0.00" }, { price: "-1.00" }, { currency: null },
    { capturedAt: "bad" }, { capturedAt: "2026-10-04T14:00:00Z" },
    { capturedAt: "2026-10-01T14:00:00Z" }, { availability: "OutOfStock" },
  ]) assert.throws(() => continentePriceArguments(observation(overrides), "p", "online", now));
});

test("commit exige service role e limites explícitos; chave pública não habilita escrita", async () => {
  assert.deepEqual(parseContinenteSyncOptions([]), { commit: false, limit: 20, offset: 0 });
  for (const args of [["--commit"], ["--commit", "--limit=20"], ["--commit", "--limit=21", "--offset=0"], ["--limit=1", "--limit=2"]]) {
    assert.throws(() => parseContinenteSyncOptions(args));
  }
  assert.equal(parseContinenteSyncOptions(["--commit", "--limit=20", "--offset=0"]).commit, true);
  const env = { EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co", EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" };
  assert.throws(() => new SupabaseContinenteSyncRepository(true, env), /SERVICE_ROLE/);
  assert.throws(() => new SupabaseContinenteSyncRepository(true, { ...env, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_test" }), /service-role/);
  let calls = 0;
  const readOnly = new SupabaseContinenteSyncRepository(false, env, async () => { calls++; return new Response("[]"); });
  await assert.rejects(readOnly.createNative({}), /Dry run forbids/);
  await assert.rejects(readOnly.upsertPrice({}), /Dry run forbids/);
  assert.equal(calls, 0);
});

test("transport envia POST exclusivamente à RPC para preços; nenhum retry implícito", async () => {
  const key = `eyJ0ZXN0Ijp0cnVlfQ.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.test`;
  const calls = [];
  const repo = new SupabaseContinenteSyncRepository(true, { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: key }, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      price_id: "102b2584-b198-4e70-af51-b321eaff1037",
      price_created: true, price_changed: false, history_created: true, stale_observation: false,
    }));
  });
  const args = continentePriceArguments(observation(), "product", "online", now);
  await repo.upsertPrice(args);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/rpc/upsert_verified_price_with_history");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), args);
});

test("contrato real da RPC aceita um UUID JSON e valida o ID", async () => {
  const key = `eyJ0ZXN0Ijp0cnVlfQ.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.test`;
  const calls = [];
  const repo = new SupabaseContinenteSyncRepository(true, {
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: key,
  }, async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return new Response(JSON.stringify("102b2584-b198-4e70-af51-b321eaff1037"));
  });
  assert.deepEqual(await repo.upsertPrice({ p_external_id: "online:123" }), {
    kind: "uuid", price_id: "102b2584-b198-4e70-af51-b321eaff1037",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/rest/v1/rpc/upsert_verified_price_with_history");
  assert.equal(calls[0].init.method, "POST");
});

test("contrato RPC continua estrito para resposta inesperada, vazia e HTTP erro", async () => {
  const key = `eyJ0ZXN0Ijp0cnVlfQ.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.test`;
  const makeRepo = (respond) => new SupabaseContinenteSyncRepository(true, {
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: key,
  }, respond);
  for (const body of [
    JSON.stringify("not-a-uuid"),
    JSON.stringify(["102b2584-b198-4e70-af51-b321eaff1037"]),
    JSON.stringify({ price_id: "not-a-uuid", price_created: true, price_changed: false, history_created: true, stale_observation: false }),
    JSON.stringify({ price_id: "102b2584-b198-4e70-af51-b321eaff1037", unexpected: true }),
    "null",
  ]) {
    const repo = makeRepo(async () => new Response(body));
    await assert.rejects(repo.upsertPrice({}), /Invalid RPC result/);
  }

  const empty = makeRepo(async () => new Response(null, { status: 204 }));
  await assert.rejects(empty.upsertPrice({}), /Invalid RPC result/);

  let attempts = 0;
  const failing = makeRepo(async () => {
    attempts += 1;
    return new Response(JSON.stringify({ code: "PGRST999" }), { status: 500 });
  });
  await assert.rejects(failing.upsertPrice({}), /HTTP 500 \(PGRST999\)/);
  assert.equal(attempts, 1);
});

test("SQL preparado contém lock, identidade única, história só inicial/alterada e acesso server-only", async () => {
  const sql = await readFile(new URL("../sql/continente-online.sql", import.meta.url), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /if created or changed then/);
  assert.match(sql, /existing\.price is distinct from p_price/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.match(sql, /store_type = 'online'/);
  assert.match(sql, /interval '36 hours'/);
});