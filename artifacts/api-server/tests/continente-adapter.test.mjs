import assert from "node:assert/strict";
import test from "node:test";
import {
  ContinenteAdapter,
  robotsAllowsPath,
} from "../tmp/price-import-test-build/services/price-import/continente-adapter.js";
import {
  isContinentePriceValid,
  parseContinenteProductHtml,
} from "../tmp/price-import-test-build/services/price-import/continente-parser.js";
import {
  createContinenteFreshnessPolicy,
  evaluateContinenteFreshness,
} from "../tmp/price-import-test-build/services/price-import/continente-freshness.js";

const sampleProduct = (overrides = {}) => ({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Leite Meio Gordo 1 L Continente",
  brand: { "@type": "Brand", name: "Continente" },
  sku: "2597619",
  mpn: "2597619",
  gtin13: "4006381333931",
  additionalProperty: [{ "@type": "PropertyValue", name: "Peso líquido", value: "500 g" }],
  offers: {
    "@type": "Offer",
    price: "1.05",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
    priceSpecification: [
      {
        "@type": "UnitPriceSpecification",
        priceType: "ListPrice",
        price: "1.19",
        priceCurrency: "EUR",
      },
      {
        "@type": "UnitPriceSpecification",
        price: "1.05",
        priceCurrency: "EUR",
        referenceQuantity: { value: 1, unitCode: "LTR" },
      },
    ],
  },
  image: "https://www.continente.pt/media/leite.jpg",
  ...overrides,
});

function productHtml(product) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head><body></body></html>`;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test("JSON-LD normaliza preço, promoção, GTIN, embalagem e ID confirmado", () => {
  const parsed = parseContinenteProductHtml(
    productHtml(sampleProduct()),
    "https://www.continente.pt/produto/leite-2597619.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );

  assert.equal(parsed.productSchemaFound, true);
  assert.equal(parsed.invalidReason, null);
  assert.equal(parsed.observation.externalProductId, "2597619");
  assert.equal(parsed.observation.externalProductIdReason, null);
  assert.equal(parsed.observation.sku, "2597619");
  assert.equal(parsed.observation.mpn, "2597619");
  assert.equal(parsed.observation.urlProductId, "2597619");
  assert.equal(parsed.observation.price, "1.05");
  assert.equal(parsed.observation.currency, "EUR");
  assert.equal(parsed.observation.regularPrice, "1.19");
  assert.equal(parsed.observation.promotion, "discounted");
  assert.equal(parsed.observation.barcode, "4006381333931");
  assert.equal(parsed.observation.packageQuantity, 500);
  assert.equal(parsed.observation.packageUnit, "g");
  assert.equal(parsed.observation.pricePerUnit, "1.05 EUR/l");
  assert.equal(parsed.observation.priceScope, "online");
  assert.equal(isContinentePriceValid(parsed.observation), true);
  assert.equal("storeId" in parsed.observation, false);
  assert.equal("store_id" in parsed.observation, false);
});

test("produto público sem preço continua extraído e não inventa validUntil", () => {
  const parsed = parseContinenteProductHtml(
    productHtml(sampleProduct({
      sku: "3245567",
      mpn: "3245567",
      gtin13: undefined,
      additionalProperty: undefined,
      offers: { "@type": "Offer", availability: "https://schema.org/InStock" },
    })),
    "https://www.continente.pt/produto/sem-preco-3245567.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );

  assert.equal(parsed.observation.externalProductId, "3245567");
  assert.equal(parsed.observation.price, null);
  assert.equal(parsed.observation.currency, null);
  assert.equal(parsed.observation.barcode, null);
  assert.equal("validUntil" in parsed.observation, false);
  assert.equal(isContinentePriceValid(parsed.observation), false);
});

test("HTML consome JSON público de aplicação e EAN só como campo do produto", () => {
  const json = {
    product: {
      name: "Café moído 250 g",
      brand: "Marca Exemplo",
      sku: "2597619",
      mpn: "2597619",
      ean: "4006381333931",
      offers: { price: "2.49", priceCurrency: "EUR" },
    },
  };
  const html = `<script id="product-data" type="application/json">${JSON.stringify(json)}</script>`;
  const parsed = parseContinenteProductHtml(
    html,
    "https://www.continente.pt/produto/cafe-2597619.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );

  assert.equal(parsed.productSchemaFound, false);
  assert.equal(parsed.observation.externalProductId, "2597619");
  assert.equal(parsed.observation.barcode, "4006381333931");
  assert.equal(parsed.observation.price, "2.49");
  assert.equal(parsed.observation.packageQuantity, 250);
  assert.equal(parsed.observation.packageUnit, "g");

  const assigned = parseContinenteProductHtml(
    `<script>window.productData = ${JSON.stringify(json.product)};</script>`,
    "https://www.continente.pt/produto/cafe-2597619.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );
  assert.equal(assigned.observation.barcode, "4006381333931");
});

test("robots.txt é aplicado a /produto/ e bloqueia caminhos proibidos", () => {
  const robots = [
    "User-agent: *",
    "Disallow: /conta/",
    "Allow: /produto/",
  ].join("\n");
  assert.equal(robotsAllowsPath(robots, "/produto/leite-2597619.html"), true);
  assert.equal(robotsAllowsPath(robots, "/conta/dados"), false);
});

test("GTIN de variantes/recomendações não é herdado pelo SKU principal", () => {
  const parsed = parseContinenteProductHtml(
    productHtml(sampleProduct({ gtin13: undefined, variants: [{ sku: "999", gtin13: "4006381333931" }] })),
    "https://www.continente.pt/produto/leite-2597619.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );
  assert.equal(parsed.observation.barcode, null);
  const supplement = `<script type="application/json">${JSON.stringify({
    product: { name: "Leite", sku: "2597619", mpn: "2597619", ean: "4006381333931" },
  })}</script>`;
  const supplemented = parseContinenteProductHtml(
    productHtml(sampleProduct({ gtin13: undefined })) + supplement,
    "https://www.continente.pt/produto/leite-2597619.html",
    new Date("2026-10-03T12:00:00.000Z"),
  );
  assert.equal(supplemented.observation.barcode, "4006381333931");
});

test("dry-run lê páginas em série, não segue redirect e repete o ID", async () => {
  const calls = [];
  const page = productHtml(sampleProduct());
  const noPricePage = productHtml(sampleProduct({
    sku: "3245567",
    mpn: "3245567",
    offers: { "@type": "Offer", availability: "https://schema.org/InStock" },
  }));
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/robots.txt") {
      return jsonResponse(
        "User-agent: *\nAllow: /produto/\nSitemap: https://www.continente.pt/sitemap_index.xml",
      );
    }
    if (url.pathname === "/sitemap_index.xml") {
      return jsonResponse(
        "<sitemapindex><sitemap><loc>https://www.continente.pt/sitemap-custom_sitemap_1-product.xml</loc></sitemap></sitemapindex>",
      );
    }
    if (url.pathname === "/sitemap-custom_sitemap_1-product.xml") {
      return jsonResponse(
        "<urlset>" +
          "<url><loc>https://www.continente.pt/produto/leite-2597619.html</loc></url>" +
          "<url><loc>https://www.continente.pt/produto/sem-preco-3245567.html</loc></url>" +
          "<url><loc>https://www.continente.pt/produto/redirect-5555555.html</loc></url>" +
          "</urlset>",
      );
    }
    if (url.pathname.endsWith("leite-2597619.html")) return jsonResponse(page);
    if (url.pathname.endsWith("sem-preco-3245567.html")) return jsonResponse(noPricePage);
    if (url.pathname.endsWith("redirect-5555555.html")) {
      return jsonResponse("", 302, { location: "https://www.continente.pt/" });
    }
    throw new Error(`Unexpected request ${url.toString()}`);
  };
  const adapter = new ContinenteAdapter({
    fetchImpl,
    requestDelayMs: 0,
    now: () => new Date("2026-10-03T12:00:00.000Z"),
  });

  const audit = await adapter.runAudit(3, 1);

  assert.equal(audit.productSitemaps.length, 1);
  assert.equal(audit.productUrlsScanned, 3);
  assert.equal(audit.productSitemapsRead, 1);
  assert.equal(audit.sampledProductUrls.length, 3);
  assert.equal(audit.firstPassAttempts.length, 3);
  assert.equal(
    audit.firstPassAttempts.find(({ url }) => url.includes("redirect-5555555.html")).outcome,
    "redirect",
  );
  assert.equal(audit.stability.attempted, 1);
  assert.equal(audit.stability.stable, 1);
  assert.equal(audit.stability.details[0].stable, true);
  assert.equal(calls.some(({ url }) => url.pathname === "/"), false);
  assert.ok(calls.every(({ init }) => init.method === "GET"));
  assert.ok(calls.every(({ init }) => init.redirect === "manual"));
});

test("redirection same-site only follows the same validated product ID", async () => {
  const calls = [];
  const oldUrl = "https://www.continente.pt/produto/slug-antigo-2597619.html";
  const newUrl = "https://www.continente.pt/produto/slug-atual-2597619.html";
  const adapter = new ContinenteAdapter({
    requestDelayMs: 0,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.toString() === oldUrl) return jsonResponse("", 301, { location: newUrl });
      if (url.toString() === newUrl) return jsonResponse(productHtml(sampleProduct()));
      throw new Error("Unexpected request");
    },
  });

  const batch = await adapter.runProductUrls([oldUrl]);
  assert.equal(batch.firstPassAttempts[0].outcome, "product");
  assert.equal(batch.firstPassAttempts[0].observation.sourceReference, newUrl);
  assert.equal(batch.firstPassAttempts[0].redirectLocation, newUrl);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init.redirect === "manual"));
});

test("a 5xx response receives a short bounded retry and counts each real page request", async () => {
  let productCalls = 0;
  const adapter = new ContinenteAdapter({
    requestDelayMs: 0,
    maxProductPageRequests: 2,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("retry-2597619.html") && productCalls++ === 0) {
        return jsonResponse("temporarily unavailable", 503);
      }
      return jsonResponse(productHtml(sampleProduct()));
    },
  });

  const batch = await adapter.runProductUrls([
    "https://www.continente.pt/produto/retry-2597619.html",
  ]);
  assert.equal(batch.firstPassAttempts[0].outcome, "product");
  assert.equal(batch.retries, 1);
  assert.equal(batch.productPageRequests, 2);
  assert.equal(productCalls, 2);
});

test("product-page request budgets stop before issuing an extra request", async () => {
  let productCalls = 0;
  const adapter = new ContinenteAdapter({
    requestDelayMs: 0,
    maxProductPageRequests: 1,
    fetchImpl: async () => {
      productCalls += 1;
      return jsonResponse(productHtml(sampleProduct()));
    },
  });
  const batch = await adapter.runProductUrls([
    "https://www.continente.pt/produto/first-2597619.html",
    "https://www.continente.pt/produto/second-2597620.html",
  ]);
  assert.equal(productCalls, 1);
  assert.equal(batch.productPageRequests, 1);
  assert.equal(batch.firstPassAttempts[1].error, "product_page_request_budget_exceeded");
  assert.match(batch.stoppedReason, /request budget/);
});

test("lotes usam offset através de vários sitemaps sem buscar todas as páginas", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/robots.txt") {
      return jsonResponse(
        "User-agent: *\nAllow: /produto/\nSitemap: https://www.continente.pt/sitemap_index.xml",
      );
    }
    if (url.pathname === "/sitemap_index.xml") {
      return jsonResponse(
        "<sitemapindex>" +
          "<sitemap><loc>https://www.continente.pt/sitemap-a-product.xml</loc></sitemap>" +
          "<sitemap><loc>https://www.continente.pt/sitemap-b-product.xml</loc></sitemap>" +
          "</sitemapindex>",
      );
    }
    if (url.pathname === "/sitemap-a-product.xml") {
      return jsonResponse(
        "<urlset>" +
          [1, 2, 3].map((id) =>
            `<url><loc>https://www.continente.pt/produto/item-${id}.html</loc></url>`
          ).join("") +
          "</urlset>",
      );
    }
    if (url.pathname === "/sitemap-b-product.xml") {
      return jsonResponse(
        "<urlset>" +
          [4, 5].map((id) =>
            `<url><loc>https://www.continente.pt/produto/item-${id}.html</loc></url>`
          ).join("") +
          "</urlset>",
      );
    }
    const id = /item-(\d+)\.html$/.exec(url.pathname)?.[1];
    if (id) {
      return jsonResponse(productHtml(sampleProduct({ sku: id, mpn: id })));
    }
    throw new Error(`Unexpected request ${url.toString()}`);
  };
  const audit = await new ContinenteAdapter({
    fetchImpl,
    requestDelayMs: 0,
  }).runAudit(2, 0, 3);

  assert.deepEqual(audit.sampledProductUrls, [
    "https://www.continente.pt/produto/item-4.html",
    "https://www.continente.pt/produto/item-5.html",
  ]);
  assert.equal(audit.productSitemapsRead, 2);
  assert.equal(audit.productUrlsScanned, 5);
  assert.equal(audit.startOffset, 3);
  assert.equal(audit.firstPassAttempts.length, 2);
  assert.equal(calls.filter(({ url }) => /item-\d+\.html$/.test(url.pathname)).length, 2);
});

test("frescura futura é configurável e não cria validUntil", () => {
  const policy = createContinenteFreshnessPolicy(60_000);
  const result = evaluateContinenteFreshness(
    "2026-10-03T11:59:30.000Z",
    new Date("2026-10-03T12:00:00.000Z"),
    policy,
  );
  assert.deepEqual(result, { fresh: true, ageMs: 30_000, reason: "within_policy" });
  assert.throws(() => createContinenteFreshnessPolicy(0), /positive safe integer/);
});