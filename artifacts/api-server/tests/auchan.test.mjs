import assert from "node:assert/strict";
import test from "node:test";
import {
  AuchanAdapter,
  auchanRobotsAllowsPath,
} from "../tmp/price-import-test-build/services/price-import/auchan-adapter.js";
import {
  isAuchanPriceValid,
  parseAuchanProductHtml,
} from "../tmp/price-import-test-build/services/price-import/auchan-parser.js";
import {
  buildAuchanDryRunReport,
} from "../tmp/price-import-test-build/services/price-import/auchan-dry-run.js";
import {
  matchAuchanProduct,
} from "../tmp/price-import-test-build/services/price-import/continente-matcher.js";
import {
  SupabaseAuchanMappingRepository,
  SupabaseAuchanReadClient,
} from "../tmp/price-import-test-build/services/price-import/supabase-auchan-read.js";
import {
  syncAuchanObservations,
} from "../tmp/price-import-test-build/services/price-import/auchan-sync.js";
import {
  SupabaseAuchanSyncRepository,
} from "../tmp/price-import-test-build/services/price-import/supabase-auchan-sync-repository.js";
import {
  resolveServerSupabaseUrl,
} from "../tmp/price-import-test-build/services/price-import/server-supabase-env.js";

const policyText = "Os preços apresentados no site Auchan.pt são os praticados nas compras online. Antes do registo e autenticação do cliente os preços apresentados servem apenas como referência e são os praticados para entregas e recolhas no código postal 2650-435 Amadora. Após o login e em função da proximidade e do código postal, serão apresentados os preços em vigor na loja que serve o local de entrega ou de recolha.";

function productHtml(overrides = {}, includePolicy = true) {
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "CALDO KNORR GALINHA 8 CUBOS 80G",
    brand: { "@type": "Brand", name: "KNORR" },
    sku: "1662",
    gtin13: "4006381333931",
    offers: {
      "@type": "Offer",
      price: "2.35",
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock",
    },
    ...overrides,
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head><body>${includePolicy ? `<footer>${policyText}</footer>` : ""}</body></html>`;
}

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test("server Supabase URL is canonical with development-only Expo fallback", () => {
  const canonical = "https://server.supabase.co";
  const legacy = "https://legacy.supabase.co";
  assert.equal(
    resolveServerSupabaseUrl({
      SUPABASE_URL: canonical,
      EXPO_PUBLIC_SUPABASE_URL: legacy,
      NODE_ENV: "production",
    }),
    canonical,
  );
  assert.equal(
    resolveServerSupabaseUrl({
      SUPABASE_URL: " ",
      EXPO_PUBLIC_SUPABASE_URL: legacy,
      NODE_ENV: "development",
    }),
    legacy,
  );
  assert.throws(
    () => resolveServerSupabaseUrl({
      EXPO_PUBLIC_SUPABASE_URL: legacy,
      NODE_ENV: "production",
    }),
    /SUPABASE_URL is required/,
  );
});

test("Auchan server repository starts from SUPABASE_URL alone", () => {
  const repository = new SupabaseAuchanSyncRepository(false, {
    SUPABASE_URL: "https://server.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, async () => {
    throw new Error("constructor must not make a request");
  });
  assert.equal(repository.commitEnabled, false);
});

test("Auchan parser usa SKU = ID da URL, GTIN válido e preço sem exigir MPN", () => {
  const parsed = parseAuchanProductHtml(
    productHtml(),
    "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(parsed.productSchemaFound, true);
  assert.equal(parsed.invalidReason, null);
  assert.equal(parsed.observation.externalProductId, "1662");
  assert.equal(parsed.observation.sku, "1662");
  assert.equal(parsed.observation.urlProductId, "1662");
  assert.equal(parsed.observation.barcode, "4006381333931");
  assert.equal(parsed.observation.brand, "KNORR");
  assert.equal(parsed.observation.packageQuantity, 80);
  assert.equal(parsed.observation.packageUnit, "g");
  assert.equal(parsed.observation.price, "2.35");
  assert.equal(parsed.observation.currency, "EUR");
  assert.equal(parsed.observation.priceScope, "reference_only_2650_435");
  assert.equal(parsed.observation.priceScopeEvidence, true);
  assert.equal(isAuchanPriceValid(parsed.observation), true);
  assert.equal("mpn" in parsed.observation, false);
  assert.equal("storeId" in parsed.observation, false);
});

test("SKU divergente e âmbito sem prova não viram identidade nem preço global", () => {
  const parsed = parseAuchanProductHtml(
    productHtml({ sku: "9999" }, false),
    "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(parsed.observation.externalProductId, null);
  assert.equal(parsed.observation.externalProductIdReason, "sku_url_id_mismatch");
  assert.equal(parsed.observation.priceScope, "unknown");
  assert.equal(parsed.observation.priceScopeEvidence, false);
});

test("HTML sem Product JSON-LD é rejeitado sem inventar produto", () => {
  const parsed = parseAuchanProductHtml(
    "<html><body>not a product page</body></html>",
    "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(parsed.observation, null);
  assert.equal(parsed.invalidReason, "product_schema_missing");
});

test("robots.txt é aplicado ao caminho /pt/ sem contornar regras", () => {
  const robots = "User-agent: *\nDisallow: /pt/account/\nAllow: /pt/";
  assert.equal(auchanRobotsAllowsPath(robots, "/pt/alimentacao/1662.html"), true);
  assert.equal(auchanRobotsAllowsPath(robots, "/pt/account/profile"), false);
});

test("adapter lê sitemap e 2 produtos em série por GET, relê IDs e nunca envia cookies", async () => {
  const calls = [];
  const productUrls = [
    "https://www.auchan.pt/pt/alimentacao/produto/10.html",
    "https://www.auchan.pt/pt/alimentacao/produto/105.html",
  ];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/robots.txt") {
      return response("User-agent: *\nAllow: /pt/\nSitemap: https://www.auchan.pt/sitemap_index.xml");
    }
    if (url.pathname === "/sitemap_index.xml") {
      return response("<sitemapindex><sitemap><loc>https://www.auchan.pt/sitemap_0-product.xml</loc></sitemap></sitemapindex>");
    }
    if (url.pathname === "/sitemap_0-product.xml") {
      return response(`<urlset>${productUrls.map((value) => `<url><loc>${value}</loc></url>`).join("")}</urlset>`);
    }
    const id = /\/(\d+)\.html$/.exec(url.pathname)?.[1];
    if (id === "10") return response(productHtml({ sku: "10", name: "PRODUTO TESTE 400G" }));
    if (id === "105") return response(productHtml({ sku: "105", name: "PRODUTO TESTE 2 200G" }));
    throw new Error(`Unexpected GET ${url}`);
  };
  const audit = await new AuchanAdapter({
    fetchImpl,
    requestDelayMs: 0,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
  }).runAudit(4, 2);

  assert.equal(audit.sampledProductUrls.length, 2);
  assert.equal(audit.firstPassAttempts.length, 2);
  assert.equal(audit.productPageRequests, 4);
  assert.equal(audit.stability.attempted, 2);
  assert.equal(audit.stability.stable, 2);
  const productCalls = calls.filter(({ url }) => url.pathname.endsWith(".html"));
  assert.equal(productCalls.length, 4);
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === "cookie"), false);
  }
});

test("Auchan sitemap daily omite SKUs conhecidos e o bookmark cobre só URLs realmente lidos", async () => {
  const calls = [];
  const productUrls = [
    "https://www.auchan.pt/pt/alimentacao/produto/10.html",
    "https://www.auchan.pt/pt/alimentacao/produto/105.html",
    "https://www.auchan.pt/pt/alimentacao/produto/200.html",
  ];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/robots.txt") {
      return response("User-agent: *\nAllow: /pt/\nSitemap: https://www.auchan.pt/sitemap_index.xml");
    }
    if (url.pathname === "/sitemap_index.xml") {
      return response("<sitemapindex><sitemap><loc>https://www.auchan.pt/sitemap_0-product.xml</loc></sitemap></sitemapindex>");
    }
    if (url.pathname === "/sitemap_0-product.xml") {
      return response(`<urlset>${productUrls.map((value) => `<url><loc>${value}</loc></url>`).join("")}</urlset>`);
    }
    const id = /\/(\d+)\.html$/.exec(url.pathname)?.[1];
    if (id) return response(productHtml({ sku: id, name: `PRODUTO TESTE ${id} 400G` }));
    throw new Error(`Unexpected GET ${url}`);
  };
  const adapter = new AuchanAdapter({
    fetchImpl,
    requestDelayMs: 0,
    maxProductPageRequests: 200,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
  });
  const plan = await adapter.discoverProductSitemaps();
  const batch = await adapter.runSitemapBatch(
    plan.productSitemaps[0],
    0,
    3,
    1,
    new Set(["10"]),
    1,
  );
  assert.deepEqual(batch.selectedUrls, productUrls.slice(0, 2));
  assert.equal(batch.skippedKnown, 1);
  assert.equal(batch.firstPassAttempts.length, 1);
  assert.equal(batch.firstPassAttempts[0].observation.externalProductId, "105");
  assert.equal(batch.nextOffset, 2);
  assert.equal(batch.totalUrls, 3);
  assert.equal(batch.productPageRequests, 2);
  assert.equal(batch.stability.stable, 1);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith(".html")).length, 2);
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === "cookie"), false);
  }
});

test("daily classifica páginas 404/410 como entradas ausentes que podem ser ignoradas", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      return response("User-agent: *\nAllow: /pt/\nSitemap: https://www.auchan.pt/sitemap_index.xml");
    }
    if (url.pathname === "/sitemap_index.xml") {
      return response("<sitemapindex><sitemap><loc>https://www.auchan.pt/sitemap_0-product.xml</loc></sitemap></sitemapindex>");
    }
    if (url.pathname === "/sitemap_0-product.xml") {
      return response("<urlset><url><loc>https://www.auchan.pt/pt/alimentacao/produto/10.html</loc></url></urlset>");
    }
    return response("not found", 404);
  };
  const audit = await new AuchanAdapter({
    fetchImpl,
    requestDelayMs: 0,
  }).runAudit(2, 1);
  assert.equal(audit.firstPassAttempts[0].outcome, "invalid_page");
  assert.equal(audit.firstPassAttempts[0].error, "product_page_missing_http_404");
});

test("adapter para na primeira resposta anti-bot e não tenta contornar", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/robots.txt") {
      return response("User-agent: *\nAllow: /pt/\nSitemap: https://www.auchan.pt/sitemap_index.xml");
    }
    if (url.pathname === "/sitemap_index.xml") {
      return response("<sitemapindex><sitemap><loc>https://www.auchan.pt/sitemap_0-product.xml</loc></sitemap></sitemapindex>");
    }
    if (url.pathname === "/sitemap_0-product.xml") {
      return response("<urlset><url><loc>https://www.auchan.pt/pt/alimentacao/produto/10.html</loc></url></urlset>");
    }
    return response("captcha required", 403);
  };
  const audit = await new AuchanAdapter({
    fetchImpl,
    requestDelayMs: 0,
  }).runAudit(3, 1);
  assert.equal(audit.firstPassAttempts[0].outcome, "blocked");
  assert.match(audit.stoppedReason, /no workaround/i);
  assert.equal(audit.productPageRequests, 1);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith(".html")).length, 1);
});

test("adapter não segue redirect para outro domínio", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      return response("User-agent: *\nAllow: /pt/\nSitemap: https://www.auchan.pt/sitemap_index.xml");
    }
    if (url.pathname === "/sitemap_index.xml") {
      return response("<sitemapindex><sitemap><loc>https://www.auchan.pt/sitemap_0-product.xml</loc></sitemap></sitemapindex>");
    }
    if (url.pathname === "/sitemap_0-product.xml") {
      return response("<urlset><url><loc>https://www.auchan.pt/pt/alimentacao/produto/10.html</loc></url></urlset>");
    }
    return response("", 302, { location: "https://example.com/pt/alimentacao/10.html" });
  };
  const audit = await new AuchanAdapter({
    fetchImpl,
    requestDelayMs: 0,
  }).runAudit(1, 0);
  assert.equal(audit.firstPassAttempts[0].outcome, "redirect");
  assert.equal(audit.productPageRequests, 1);
});

test("matching Auchan prioriza mapping, produto nativo e GTIN, depois nome+marca", async () => {
  const observation = {
    sourceType: "auchan",
    externalProductId: "1662",
    barcode: "4006381333931",
    name: "Produto Exemplo 400G",
    brand: "Marca",
    packageQuantity: 400,
    packageUnit: "g",
  };
  const sourceNative = {
    id: "native",
    name: "Produto Exemplo 400G",
    brand: "Marca",
    barcode: "0000000000000",
    unit: "g",
    active: true,
    sourceType: "auchan",
    externalId: "1662",
  };
  const barcodeProduct = {
    id: "barcode",
    name: "Nome diferente",
    brand: "Outra",
    barcode: "4006381333931",
    unit: "g",
    active: true,
    sourceType: null,
    externalId: null,
  };
  const emptyMappings = { findMappings: async () => [] };

  const native = await matchAuchanProduct(
    observation,
    [sourceNative, barcodeProduct],
    emptyMappings,
  );
  assert.equal(native.method, "source_native_exact");
  assert.equal(native.product.id, "native");

  const mapped = await matchAuchanProduct(
    observation,
    [sourceNative, barcodeProduct],
    {
      findMappings: async () => [{
        sourceType: "auchan",
        externalProductId: "1662",
        productId: "barcode",
        matchMethod: "manual_verified",
        confidence: 1,
        verified: true,
      }],
    },
  );
  assert.equal(mapped.method, "verified_external_mapping");
  assert.equal(mapped.product.id, "barcode");

  const byBarcode = await matchAuchanProduct(observation, [barcodeProduct], emptyMappings);
  assert.equal(byBarcode.method, "barcode_exact");

  const byName = await matchAuchanProduct(observation, [{
    id: "name",
    name: "Produto Exemplo 400G",
    brand: "Marca",
    barcode: null,
    unit: "g",
    active: true,
    sourceType: null,
    externalId: null,
  }], emptyMappings);
  assert.equal(byName.method, "name_brand_exact_unique");
});

test("dry-run nunca escreve e só habilita uma referência fresca com identidade e âmbito estáveis", async () => {
  const observation = {
    sourceType: "auchan",
    externalProductId: "1662",
    externalProductIdReason: null,
    sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    name: "CALDO KNORR GALINHA 8 CUBOS 80G",
    brand: "KNORR",
    barcode: "4006381333931",
    sku: "1662",
    urlProductId: "1662",
    price: "2.35",
    currency: "EUR",
    regularPrice: null,
    promotion: null,
    packageQuantity: 8,
    packageUnit: "un",
    availability: "InStock",
    image: null,
    capturedAt: "2026-10-04T10:00:00.000Z",
    priceScope: "reference_only_2650_435",
    priceScopeEvidence: true,
  };
  const audit = {
    robotsUrl: "https://www.auchan.pt/robots.txt",
    robotsAllowsProductPages: true,
    sitemapIndexUrl: "https://www.auchan.pt/sitemap_index.xml",
    productSitemaps: ["https://www.auchan.pt/sitemap_0-product.xml"],
    productSitemapsRead: 1,
    productUrlsScanned: 1,
    startOffset: 0,
    sampledSitemapUrl: "https://www.auchan.pt/sitemap_0-product.xml",
    sampledProductUrls: [observation.sourceReference],
    firstPassAttempts: [{
      url: observation.sourceReference,
      outcome: "product",
      status: 200,
      redirectLocation: null,
      observation,
      error: null,
    }],
    stability: {
      target: 1,
      attempted: 1,
      stable: 1,
      changed: 0,
      failed: 0,
      details: [{
        url: observation.sourceReference,
        stable: true,
        firstExternalProductId: "1662",
        repeatedExternalProductId: "1662",
      }],
    },
    stoppedReason: null,
    productPageRequests: 2,
  };
  const report = await buildAuchanDryRunReport(
    { runAudit: async () => audit },
    { loadAllProducts: async () => [] },
    { findMappings: async () => [] },
    {
      pageRequestBudget: 2,
      stabilityReads: 1,
      now: () => new Date("2026-10-04T10:00:00.000Z"),
    },
  );
  assert.equal(report.writesEnabled, false);
  assert.equal(report.storeCreationEnabled, false);
  assert.equal(report.counts.pricesExtracted, 1);
  assert.equal(report.counts.pricesSafeToImport, 1);
  assert.equal(report.items[0].priceSafeToImport, true);
  assert.equal(report.items[0].plannedProductAction, "create_source_native");

  const ambiguous = await buildAuchanDryRunReport(
    { runAudit: async () => audit },
    {
      loadAllProducts: async () => [
        {
          id: "candidate-a", name: observation.name, brand: observation.brand,
          barcode: observation.barcode, unit: "un", active: true,
          sourceType: null, externalId: null,
        },
        {
          id: "candidate-b", name: observation.name, brand: observation.brand,
          barcode: observation.barcode, unit: "un", active: true,
          sourceType: null, externalId: null,
        },
      ],
    },
    { findMappings: async () => [] },
    {
      pageRequestBudget: 2,
      stabilityReads: 1,
      now: () => new Date("2026-10-04T10:00:00.000Z"),
    },
  );
  assert.equal(ambiguous.items[0].match.level, "ambiguous");
  assert.equal(ambiguous.items[0].plannedProductAction, "review_ambiguous");
  assert.equal(ambiguous.items[0].priceSafeToImport, false);
  assert.ok(ambiguous.items[0].importBlockers.includes("ambiguous_catalog_match"));
});

test("Supabase Auchan client só permite GET e mapping lookup filtrado por Auchan", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return response(JSON.stringify([{
      source_type: "auchan",
      external_product_id: "1662",
      product_id: "product-1",
      match_method: "manual_verified",
      confidence: 1,
      verified: true,
    }]), 200, { "content-type": "application/json" });
  };
  const client = new SupabaseAuchanReadClient({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-only-secret",
  }, fetchImpl);
  const mappings = await new SupabaseAuchanMappingRepository(client)
    .findMappings("auchan", "1662");
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].productId, "product-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.pathname, "/rest/v1/external_product_mappings");
  assert.equal(calls[0].url.searchParams.get("source_type"), "eq.auchan");
  assert.equal(calls[0].url.searchParams.get("external_product_id"), "eq.1662");
});

test("checkpoint diário usa source_type=auchan e atualiza com comparação otimista", async () => {
  const calls = [];
  const existing = {
    source_type: "auchan",
    cursor_value: "discovery:1:0:8",
    last_attempt_at: "2026-10-04T10:00:00.000Z",
    last_success_at: "2026-10-03T10:00:00.000Z",
    last_error: null,
    metadata: { dailySyncVersion: 1, phase: "discovery" },
    updated_at: "2026-10-04T10:00:00.000Z",
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (init.method === "GET") {
      assert.equal(url.searchParams.get("source_type"), "eq.auchan");
      return response(JSON.stringify([existing]), 200, { "content-type": "application/json" });
    }
    assert.equal(url.pathname, "/rest/v1/source_sync_state");
    assert.equal(JSON.parse(init.body).source_type, "auchan");
    return response(JSON.stringify([{
      ...JSON.parse(init.body),
      updated_at: "2026-10-04T10:05:00.000Z",
    }]), 200, { "content-type": "application/json" });
  };
  const repository = new SupabaseAuchanSyncRepository(true, {
    SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, fetchImpl);
  const loaded = await repository.loadDailyCheckpoint();
  assert.equal(loaded.source_type, "auchan");
  assert.equal(loaded.cursor_value, existing.cursor_value);
  const updated = await repository.updateDailyCheckpoint(existing.updated_at, {
    source_type: "auchan",
    cursor_value: "discovery:1:0:9",
    last_attempt_at: "2026-10-04T10:05:00.000Z",
    last_success_at: "2026-10-03T10:00:00.000Z",
    last_error: null,
    metadata: { dailySyncVersion: 1, phase: "discovery" },
  });
  assert.equal(updated.cursor_value, "discovery:1:0:9");
  const patchCall = calls.find(({ init }) => init.method === "PATCH");
  assert.equal(patchCall.url.searchParams.get("source_type"), "eq.auchan");
  assert.equal(patchCall.url.searchParams.get("updated_at"), `eq.${existing.updated_at}`);
  assert.equal(calls.length, 2);
});

test("daily refresher resolves SKU only from the exact Amadora-scoped price identity", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return response(JSON.stringify([{
      external_id: "reference:2650-435:1662",
      source_reference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
      captured_at: "2026-10-04T10:00:00.000Z",
      valid_until: "2026-10-05T22:00:00.000Z",
      price: "2.35",
      product_id: "a5a2c1d2-0000-4000-8000-000000000001",
    }]), 200, { "content-type": "application/json" });
  };
  const repository = new SupabaseAuchanSyncRepository(false, {
    SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, fetchImpl);

  assert.deepEqual(await repository.loadDailyPriceCandidates(
    "1fb7c654-65df-48e0-9615-95d0d5cba800",
  ), [{
    sku: "1662",
    sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    capturedAt: "2026-10-04T10:00:00.000Z",
    validUntil: "2026-10-05T22:00:00.000Z",
    price: "2.35",
    productId: "a5a2c1d2-0000-4000-8000-000000000001",
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.searchParams.get("source_type"), "eq.auchan");
  assert.equal(
    calls[0].url.searchParams.get("store_id"),
    "eq.1fb7c654-65df-48e0-9615-95d0d5cba800",
  );
});

test("daily refresher rejects price identities outside the exact Amadora namespace", async () => {
  const fetchImpl = async () => response(JSON.stringify([{
    external_id: "reference:2650-434:1662",
    source_reference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    captured_at: "2026-10-04T10:00:00.000Z",
    valid_until: null,
    price: "2.35",
    product_id: "a5a2c1d2-0000-4000-8000-000000000001",
  }]), 200, { "content-type": "application/json" });
  const repository = new SupabaseAuchanSyncRepository(false, {
    SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, fetchImpl);

  await assert.rejects(
    () => repository.loadDailyPriceCandidates(
      "1fb7c654-65df-48e0-9615-95d0d5cba800",
    ),
    /invalid refresh fields/i,
  );
});

test("existing reference-price lookup uses the store-scoped external identity", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return response(JSON.stringify([{
      id: "price-1",
      product_id: "a5a2c1d2-0000-4000-8000-000000000001",
      store_id: "1fb7c654-65df-48e0-9615-95d0d5cba800",
      price: "2.35",
      currency: "EUR",
      captured_at: "2026-10-04T10:00:00.000Z",
      valid_until: "2026-10-05T22:00:00.000Z",
      source_type: "auchan",
      source_reference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
      verification_status: "verified",
    }]), 200, { "content-type": "application/json" });
  };
  const repository = new SupabaseAuchanSyncRepository(false, {
    SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, fetchImpl);

  const price = await repository.findLatestReferencePrice(
    "a5a2c1d2-0000-4000-8000-000000000001",
    "1fb7c654-65df-48e0-9615-95d0d5cba800",
    "1662",
  );
  assert.equal(price?.id, "price-1");
  assert.equal(
    calls[0].url.searchParams.get("external_id"),
    "eq.reference:2650-435:1662",
  );
  assert.equal(calls[0].init.method, "GET");
});

function syncItem(overrides = {}) {
  const observation = {
    sourceType: "auchan",
    externalProductId: "1662",
    externalProductIdReason: null,
    sourceReference: "https://www.auchan.pt/pt/alimentacao/produto/1662.html",
    name: "PRODUTO SEM FORMATO CONHECIDO",
    brand: null,
    barcode: null,
    sku: "1662",
    urlProductId: "1662",
    price: "2.35",
    currency: "EUR",
    regularPrice: null,
    promotion: null,
    packageQuantity: null,
    packageUnit: null,
    availability: "InStock",
    image: null,
    capturedAt: "2026-10-04T10:00:00.000Z",
    priceScope: "reference_only_2650_435",
    priceScopeEvidence: true,
  };
  return {
    observation: { ...observation, ...overrides },
    match: {
      level: "unmatched",
      method: null,
      candidateCount: 0,
      product: null,
      confidence: 0,
      explanation: "No verified match",
    },
    plannedProductAction: "create_source_native",
    identityStable: true,
    priceUsableForProduct: false,
    priceSafeToImport: true,
    importBlockers: [],
  };
}

function syncRepository({ commitEnabled = false, rpcAcknowledgementFails = false, blockers = [] } = {}) {
  const storeId = "1fb7c654-65df-48e0-9615-95d0d5cba800";
  const productId = "a5a2c1d2-0000-4000-8000-000000000001";
  const state = {
    writes: [],
    mappings: [],
    products: [],
    price: null,
    historyCapturedAt: null,
    historyPrice: null,
    rpcCalls: [],
  };
  const repo = {
    commitEnabled,
    state,
    preflight: async () => ({
      blockers,
      referenceStore: { id: storeId, name: "Auchan 2650-435" },
      mappingsAvailable: true,
      capabilities: {
        productIdentityUnique: true,
        storeIdentityUnique: true,
        priceIdentityUnique: true,
        referenceStoreExists: true,
      },
    }),
    findMappings: async (sku) => state.mappings.filter((mapping) => mapping.externalProductId === sku),
    findSourceProducts: async (sku) => state.products.filter((product) => product.externalId === sku),
    findProduct: async (id) => state.products.find((product) => product.id === id) ?? null,
    createNative: async (fields) => {
      state.writes.push(["product", fields]);
      const product = {
        id: productId,
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
      state.writes.push(["mapping", fields]);
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
    upsertReferencePrice: async (args) => {
      state.writes.push(["price", args]);
      state.rpcCalls.push(args);
      const nextPrice = Number(args.p_price).toFixed(2);
      const priceChanged = state.price?.price !== nextPrice;
      state.price = {
        id: "price-row",
        productId: args.p_product_id,
        storeId,
        price: nextPrice,
        currency: "EUR",
        capturedAt: args.p_captured_at,
        validUntil: new Date(Date.parse(args.p_captured_at) + 36 * 60 * 60 * 1000).toISOString(),
        sourceType: "auchan",
        sourceReference: args.p_source_reference,
        verificationStatus: "verified",
      };
      if (priceChanged) {
        state.historyCapturedAt = args.p_captured_at;
        state.historyPrice = nextPrice;
      }
      if (rpcAcknowledgementFails) throw new Error("simulated lost RPC acknowledgement");
      return { id: "price-row" };
    },
    findLatestReferencePrice: async () => state.price,
    findReferencePrice: async (_productId, _storeId, sourceReference, at) =>
      state.price?.sourceReference === sourceReference && state.price?.capturedAt === at
        ? state.price
        : null,
    hasReferencePriceHistory: async (_productId, _storeId, price, at) =>
      state.historyPrice === price && state.historyCapturedAt === at,
  };
  return repo;
}

test("Auchan dry-run planeia produtos nativos sem executar qualquer mutação", async () => {
  const repo = syncRepository();
  const report = await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(report.mode, "dry-run");
  assert.equal(report.writesEnabled, false);
  assert.equal(report.counts.nativePlanned, 1);
  assert.equal(report.referenceStore.action, "reuse");
  assert.equal(report.referenceStore.creationAllowed, false);
  assert.deepEqual(repo.state.writes, []);
});

test("Auchan commit usa produto nativo, mapping verificado e GET para confirmar preço e histórico", async () => {
  const repo = syncRepository({ commitEnabled: true });
  const report = await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(report.mode, "commit");
  assert.equal(report.counts.sourceNativeCreated, 1);
  assert.equal(report.counts.mappingsCreated, 1);
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.counts.pricesCreated, 1);
  assert.equal(report.counts.historyRowsConfirmed, 1);
  assert.equal(report.counts.errors, 0);
  assert.equal(report.items[0].action, "price_and_history_confirmed");
  assert.equal(repo.state.writes.length, 3);
  const product = repo.state.writes[0][1];
  assert.equal(product.source_type, "auchan");
  assert.equal(product.external_id, "1662");
  assert.equal(product.barcode, null);
  assert.equal(product.category, null);
  assert.equal(product.unit, null);
  assert.equal(product.package_quantity, null);
  assert.equal(repo.state.writes[1][1].verified, true);
  assert.equal(repo.state.writes[2][1].p_product_id, "a5a2c1d2-0000-4000-8000-000000000001");
  assert.equal(repo.state.writes[2][1].p_external_product_id, "1662");
  assert.equal(repo.state.writes[2][1].p_source_reference, syncItem().observation.sourceReference);
});

test("Auchan preço igual renova 36 horas sem criar histórico duplicado", async () => {
  const repo = syncRepository({ commitEnabled: true });
  const first = await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  const originalHistoryAt = repo.state.historyCapturedAt;
  const refreshedAt = "2026-10-04T11:00:00.000Z";
  const second = await syncAuchanObservations(
    [syncItem({ capturedAt: refreshedAt })],
    repo,
    new Date(refreshedAt),
  );
  assert.equal(first.counts.historyRowsConfirmed, 1);
  assert.equal(second.counts.pricesWritten, 1);
  assert.equal(second.counts.pricesUnchanged, 1);
  assert.equal(second.counts.pricesUpdated, 1);
  assert.equal(second.counts.historyRowsSuppressed, 1);
  assert.equal(second.counts.historyRowsConfirmed, 0);
  assert.equal(second.counts.errors, 0);
  assert.equal(second.items[0].action, "price_refreshed_without_duplicate_history");
  assert.equal(repo.state.price.capturedAt, refreshedAt);
  assert.equal(
    repo.state.price.validUntil,
    new Date(Date.parse(refreshedAt) + 36 * 60 * 60 * 1000).toISOString(),
  );
  assert.equal(repo.state.historyCapturedAt, originalHistoryAt);
  assert.equal(repo.state.rpcCalls.length, 2);
});

test("Auchan mudança de preço cria histórico novo", async () => {
  const repo = syncRepository({ commitEnabled: true });
  await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  const changedAt = "2026-10-04T11:00:00.000Z";
  const changed = await syncAuchanObservations(
    [syncItem({ price: "3.10", capturedAt: changedAt })],
    repo,
    new Date(changedAt),
  );
  assert.equal(changed.counts.priceChanges, 1);
  assert.equal(changed.counts.historyRowsConfirmed, 1);
  assert.equal(changed.counts.historyRowsSuppressed, 0);
  assert.equal(changed.counts.errors, 0);
  assert.equal(repo.state.price.price, "3.10");
  assert.equal(repo.state.historyCapturedAt, changedAt);
  assert.equal(repo.state.historyPrice, "3.10");
});

test("acknowledgement incerto só é aceite depois de GET confirmar a escrita, sem replay", async () => {
  const repo = syncRepository({ commitEnabled: true, rpcAcknowledgementFails: true });
  const report = await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.equal(report.counts.pricesWritten, 1);
  assert.equal(report.items[0].rpcAcknowledgementResolved, true);
  assert.match(report.items[0].error, /recovered by GET/i);
  assert.equal(repo.state.rpcCalls.length, 1);
});

test("lote Auchan com mais de 20 produtos é rejeitado antes de qualquer preflight ou escrita", async () => {
  const repo = syncRepository({ commitEnabled: true });
  await assert.rejects(
    () => syncAuchanObservations(
      Array.from({ length: 21 }, () => syncItem()),
      repo,
      new Date("2026-10-04T10:00:00.000Z"),
    ),
    /safety limit/,
  );
  assert.deepEqual(repo.state.writes, []);
});

test("preflight bloqueado impede qualquer inserção Auchan", async () => {
  const repo = syncRepository({ commitEnabled: true, blockers: ["identity uniqueness missing"] });
  const report = await syncAuchanObservations(
    [syncItem()],
    repo,
    new Date("2026-10-04T10:00:00.000Z"),
  );
  assert.ok(report.counts.errors > 0);
  assert.deepEqual(repo.state.writes, []);
});

test("o repositório Auchan rejeita mutações quando criado em modo dry-run", async () => {
  const calls = [];
  const repository = new SupabaseAuchanSyncRepository(false, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  }, async (...args) => {
    calls.push(args);
    throw new Error("fetch must not run");
  });
  await assert.rejects(
    () => repository.createNative({ source_type: "auchan", external_id: "1662" }),
    /dry-run forbids database mutations/,
  );
  assert.deepEqual(calls, []);
});