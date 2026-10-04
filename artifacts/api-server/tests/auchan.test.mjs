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

test("dry-run nunca habilita writes nem converte o preço de referência em preço importável", async () => {
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
      details: [],
    },
    stoppedReason: null,
    productPageRequests: 2,
  };
  const report = await buildAuchanDryRunReport(
    { runAudit: async () => audit },
    { loadAllProducts: async () => [] },
    { findMappings: async () => [] },
    { pageRequestBudget: 2, stabilityReads: 1 },
  );
  assert.equal(report.writesEnabled, false);
  assert.equal(report.storeCreationEnabled, false);
  assert.equal(report.counts.pricesExtracted, 1);
  assert.equal(report.counts.pricesSafeToImport, 0);
  assert.equal(report.items[0].priceSafeToImport, false);
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