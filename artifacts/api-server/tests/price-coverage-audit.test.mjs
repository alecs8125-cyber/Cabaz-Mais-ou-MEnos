import assert from "node:assert/strict";
import test from "node:test";
import { buildPriceCoverageAuditReport } from "../tmp/price-coverage-test-build/services/price-import/price-coverage-audit.js";
import {
  readPriceCoverageAuditInput,
  SupabasePriceCoverageReadClient,
} from "../tmp/price-coverage-test-build/services/price-import/supabase-price-coverage-read.js";
import {
  buildPriceSourceHealthReport,
} from "../tmp/price-coverage-test-build/services/price-import/price-source-health.js";
import {
  readPriceSourceHealthData,
  SupabasePriceSourceHealthReadClient,
} from "../tmp/price-coverage-test-build/services/price-import/supabase-price-source-health-read.js";

const asOf = new Date("2026-10-04T12:00:00.000Z");
const continenteOnline = {
  id: "store-continente-online",
  name: "Continente Online",
  active: true,
  source_type: "continente",
  external_id: "online",
  store_type: "online",
  district: null,
  municipality: null,
  parish: null,
  latitude: null,
  longitude: null,
  postal_code: null,
  chain_name: "Continente",
};
const auchanReference = {
  id: "store-auchan-reference",
  name: "Auchan Amadora",
  active: true,
  source_type: "auchan",
  external_id: "reference:2650-435",
  store_type: "online_reference",
  district: "Lisboa",
  municipality: "Amadora",
  parish: null,
  latitude: null,
  longitude: null,
  postal_code: "2650-435",
  chain_name: "Auchan",
};

function product(id, externalId, sourceType = "continente", active = true) {
  return { id, source_type: sourceType, external_id: externalId, active };
}

function price(id, productId, storeId, fields = {}) {
  return {
    id,
    product_id: productId,
    store_id: storeId,
    source_type: "continente",
    external_id: `online:${id}`,
    verification_status: "verified",
    captured_at: "2026-10-04T10:00:00.000Z",
    valid_from: null,
    valid_until: "2026-10-05T10:00:00.000Z",
    ...fields,
  };
}

test("reporta cobertura, frescura, duplicados e órfãos com um instante determinístico", () => {
  const input = {
    products: [
      product("c1", "sku-1"),
      product("c2", "sku-2"),
      product("c1-copy", "sku-1"),
    ],
    stores: [continenteOnline],
    mappings: [
      { id: "m1", source_type: "continente", external_product_id: "sku-1", product_id: "c1" },
      { id: "m2", source_type: "continente", external_product_id: "sku-1", product_id: "c1-copy" },
      { id: "m3", source_type: "continente", external_product_id: "orphan", product_id: "missing-product" },
    ],
    prices: [
      price("p1", "c1", continenteOnline.id, {
        captured_at: "2026-10-04T10:00:00.000Z",
        valid_until: "2026-10-04T12:00:00.000Z",
      }),
      price("p2", "c2", continenteOnline.id, {
        captured_at: "2026-10-04T09:00:00.000Z",
        valid_until: "2026-10-04T11:59:59.000Z",
      }),
      price("p3", "missing-product", continenteOnline.id, {
        captured_at: "2026-10-04T00:00:00.000Z",
      }),
      price("p4", "c1", "missing-store", {
        captured_at: "invalid-timestamp",
        verification_status: "rejected",
      }),
    ],
  };

  const report = buildPriceCoverageAuditReport(input, asOf);
  assert.equal(report.generatedAt, asOf.toISOString());
  const source = report.sources.find((entry) => entry.sourceType === "continente");
  assert.ok(source);
  assert.deepEqual(source.products, {
    total: 3,
    active: 3,
    duplicateIdentities: { groups: 1, extraRows: 1 },
  });
  assert.deepEqual(source.mappings, {
    total: 3,
    duplicateIdentities: { groups: 1, extraRows: 1 },
    orphanRows: 1,
  });
  assert.deepEqual(source.prices.duplicateIdentities, { groups: 0, extraRows: 0 });

  const online = source.channels.find((entry) => entry.channel === "online");
  assert.ok(online);
  assert.equal(online.prices, 3);
  assert.equal(online.verifiedPrices, 3);
  assert.equal(online.validPrices, 2);
  assert.equal(online.expiredVerifiedPrices, 1);
  assert.equal(online.coverage.coveredActiveProducts, 1);
  assert.equal(online.coverage.activeProducts, 3);
  assert.equal(online.coverage.percent, 33.33);
  assert.deepEqual(online.capturedAtAgeHours, {
    count: 3,
    invalidTimestamps: 0,
    minHours: 2,
    medianHours: 3,
    p90Hours: 12,
    maxHours: 12,
  });
  assert.deepEqual(online.orphanPrices, {
    rows: 1,
    missingProductRows: 1,
    missingStoreRows: 0,
  });

  const missingStore = source.channels.find((entry) => entry.channel === "loja em falta");
  assert.ok(missingStore);
  assert.equal(missingStore.prices, 1);
  assert.equal(missingStore.orphanPrices.missingStoreRows, 1);
  assert.equal(missingStore.capturedAtAgeHours.invalidTimestamps, 0);
  assert.equal(report.readOnly, true);
  assert.equal(report.databaseWrites, 0);
  assert.equal(report.rpcCalls, 0);
});

test("considera preços verificados válidos nos limites inclusivos e separa estados não atuais", () => {
  const input = {
    products: [product("c1", "sku-1"), product("c2", "sku-2")],
    stores: [continenteOnline],
    mappings: [],
    prices: [
      price("at-boundary", "c1", continenteOnline.id, {
        captured_at: asOf.toISOString(),
        valid_from: asOf.toISOString(),
        valid_until: asOf.toISOString(),
      }),
      price("future", "c2", continenteOnline.id, {
        valid_from: "2026-10-04T12:00:01.000Z",
      }),
      price("pending", "c2", continenteOnline.id, {
        verification_status: "pending",
      }),
    ],
  };
  const report = buildPriceCoverageAuditReport(input, asOf);
  const online = report.sources[0]?.channels.find((entry) => entry.channel === "online");
  assert.ok(online);
  assert.equal(online.verifiedPrices, 2);
  assert.equal(online.validPrices, 1);
  assert.equal(online.expiredVerifiedPrices, 0);
  assert.equal(online.notCurrentVerifiedPrices, 1);
  assert.equal(online.coverage.coveredActiveProducts, 1);
});

test("confirma os âmbitos Continente Online e Auchan Amadora e sinaliza desvios", () => {
  const inScopePrices = [
    price("c", "c1", continenteOnline.id),
    price("a", "a1", auchanReference.id, { source_type: "auchan" }),
  ];
  const valid = buildPriceCoverageAuditReport({
    products: [product("c1", "csku"), product("a1", "asku", "auchan")],
    stores: [continenteOnline, auchanReference],
    mappings: [],
    prices: inScopePrices,
  }, asOf);
  assert.equal(valid.expectedScopes.continenteOnline.ok, true);
  assert.equal(valid.expectedScopes.auchanAmadoraReference.ok, true);
  assert.equal(valid.expectedScopes.auchanAmadoraReference.pricesInExpectedChannel, 1);

  const genericOnline = {
    ...auchanReference,
    id: "store-auchan-online",
    name: "Auchan Online",
    external_id: "online",
    store_type: "online",
    postal_code: null,
  };
  const badReference = { ...auchanReference, district: "Porto" };
  const outOfScopePrices = [
    ...inScopePrices,
    price("bad-auchan", "a1", genericOnline.id, { source_type: "auchan" }),
  ];
  const invalid = buildPriceCoverageAuditReport({
    products: [product("c1", "csku"), product("a1", "asku", "auchan")],
    stores: [continenteOnline, badReference, genericOnline],
    mappings: [],
    prices: outOfScopePrices,
  }, asOf);
  assert.equal(invalid.expectedScopes.auchanAmadoraReference.ok, false);
  assert.ok(invalid.expectedScopes.auchanAmadoraReference.issues.includes("generic_auchan_online_store_present"));
  assert.ok(invalid.expectedScopes.auchanAmadoraReference.issues.includes("prices_outside_auchan_amadora_reference"));
});

test("a leitura Supabase pagina as quatro tabelas com GET e sem endpoint RPC", async () => {
  const rowsByTable = {
    products: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    stores: [{ id: "s1" }],
    external_product_mappings: [{ id: "m1" }, { id: "m2" }],
    prices: [{ id: "v1" }, { id: "v2" }, { id: "v3" }, { id: "v4" }],
  };
  const calls = [];
  const serviceRoleMarker = "test-service-role-marker";
  const client = new SupabasePriceCoverageReadClient({
    url: "https://example.supabase.co",
    serviceRoleKey: serviceRoleMarker,
  }, async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const table = url.pathname.split("/").at(-1);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const page = rowsByTable[table].slice(offset, offset + limit);
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const input = await readPriceCoverageAuditInput(client, {
    pageSize: 2,
    maxRowsPerTable: 10,
  });
  assert.deepEqual(
    [input.products.length, input.stores.length, input.mappings.length, input.prices.length],
    [3, 1, 2, 4],
  );
  assert.equal(calls.every(({ init }) => init.method === "GET"), true);
  assert.equal(calls.every(({ url }) => !url.pathname.includes("/rpc/")), true);
  assert.equal(calls.every(({ url }) => url.searchParams.get("order") === "id.asc"), true);
  assert.equal(calls.every(({ init }) =>
    new Headers(init.headers).get("authorization") === `Bearer ${serviceRoleMarker}`
  ), true);
  assert.equal(calls.some(({ url }) => url.searchParams.get("offset") === "2"), true);
});

test("o cliente rejeita tabelas fora da lista e não expõe a credencial nos erros", async () => {
  const serviceRoleMarker = "must-not-appear-in-errors";
  const client = new SupabasePriceCoverageReadClient({
    url: "https://example.supabase.co",
    serviceRoleKey: serviceRoleMarker,
  }, async () => new Response("denied", { status: 403 }));

  await assert.rejects(
    client.getRows("products", { select: "id" }),
    (error) => error.message.includes("HTTP 403") &&
      !error.message.includes(serviceRoleMarker),
  );
  await assert.rejects(
    client.getRows("source_sync_state", { select: "*" }),
    /not allowlisted/,
  );
});

function healthCapabilities(sourceType) {
  return {
    product_identity_unique: true,
    store_identity_unique: true,
    price_identity_unique: true,
    ...(sourceType === "auchan" ? { reference_store_exists: true } : {}),
  };
}

function checkpoint(sourceType, overrides = {}) {
  return {
    source_type: sourceType,
    cursor_value: "complete:1",
    last_attempt_at: "2026-10-04T11:00:00.000Z",
    last_success_at: "2026-10-04T11:00:00.000Z",
    last_error: null,
    metadata: {
      dailySyncVersion: 1,
      phase: "complete",
      run: { id: "test-run", status: "complete", lock: null },
    },
    updated_at: "2026-10-04T11:00:00.000Z",
    ...overrides,
  };
}

function healthReadResult(overrides = {}) {
  return {
    capabilities: {
      continente: healthCapabilities("continente"),
      auchan: healthCapabilities("auchan"),
      ...overrides.capabilities,
    },
    capabilityErrors: {
      continente: null,
      auchan: null,
      ...overrides.capabilityErrors,
    },
    checkpoints: {
      continente: [checkpoint("continente")],
      auchan: [checkpoint("auchan")],
      ...overrides.checkpoints,
    },
    checkpointErrors: {
      continente: null,
      auchan: null,
      ...overrides.checkpointErrors,
    },
  };
}

test("health check confirma capabilities, checkpoints e preços válidos nas referências esperadas", () => {
  const prices = [
    price("healthy-continente", "c1", continenteOnline.id),
    price("healthy-auchan", "a1", auchanReference.id, { source_type: "auchan" }),
  ];
  const report = buildPriceSourceHealthReport(
    [continenteOnline, auchanReference],
    prices,
    healthReadResult(),
    asOf,
  );

  assert.equal(report.generatedAt, asOf.toISOString());
  assert.equal(report.readOnly, true);
  assert.equal(report.databaseWrites, 0);
  assert.equal(report.capabilityRpcGets, 2);
  assert.deepEqual(report.sources.map(({ sourceType, ok }) => [sourceType, ok]), [
    ["continente", true],
    ["auchan", true],
  ]);
  assert.equal(report.sources[0].checkpoint.status, "complete");
  assert.equal(report.sources[0].prices.validAtExpectedReference, 1);
  assert.equal(report.sources[1].capabilities.referenceStoreExists, true);
  assert.equal(report.sources[1].prices.hasValidPriceAtExpectedReference, true);
});

test("health check falha em referências ausentes, checkpoint com lease expirado e sem preço válido", () => {
  const report = buildPriceSourceHealthReport(
    [continenteOnline],
    [
      price("expired-auchan", "a1", "missing-auchan-store", {
        source_type: "auchan",
        valid_until: "2026-10-04T11:59:59.000Z",
      }),
    ],
    healthReadResult({
      checkpoints: {
        continente: [],
        auchan: [checkpoint("auchan", {
          metadata: {
            dailySyncVersion: 1,
            phase: "discovery",
            run: {
              id: "expired-run",
              status: "running",
              lock: {
                runId: "expired-run",
                expiresAt: "2026-10-04T11:00:00.000Z",
              },
            },
          },
        })],
      },
    }),
    asOf,
  );

  assert.equal(report.sources[0].checkpoint.status, "missing");
  assert.equal(report.sources[0].reference.ok, true);
  assert.equal(report.sources[0].ok, false);
  assert.equal(report.sources[1].checkpoint.status, "stale_lock");
  assert.equal(report.sources[1].reference.ok, false);
  assert.equal(report.sources[1].prices.expired, 1);
  assert.equal(report.sources[1].prices.validAtExpectedReference, 0);
  assert.equal(report.sources[1].ok, false);
});

test("cliente do health check só faz GET aos checkpoints e às capabilities allowlisted", async () => {
  const calls = [];
  const client = new SupabasePriceSourceHealthReadClient({
    url: "https://example.supabase.co",
    serviceRoleKey: "health-test-service-role-marker",
  }, async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = url.pathname.endsWith("/source_sync_state")
      ? [checkpoint(url.searchParams.get("source_type").slice(3))]
      : healthCapabilities(url.pathname.includes("auchan") ? "auchan" : "continente");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const data = await readPriceSourceHealthData(client);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ init }) => init.method === "GET"), true);
  assert.equal(calls.every(({ url }) =>
    url.pathname.endsWith("/source_sync_state") ||
    url.pathname.endsWith("/rpc/continente_sync_capabilities") ||
    url.pathname.endsWith("/rpc/auchan_sync_capabilities")
  ), true);
  assert.equal(calls.every(({ url }) =>
    url.pathname.endsWith("/source_sync_state")
      ? url.searchParams.get("select") ===
        "source_type,cursor_value,last_attempt_at,last_success_at,last_error,metadata,updated_at"
      : true
  ), true);
  assert.equal(data.capabilities.continente.product_identity_unique, true);
  assert.equal(data.checkpoints.auchan[0].source_type, "auchan");
  assert.throws(() => client.getCapabilities("unexpected"), /not allowlisted/);
  await assert.rejects(client.getCheckpointRows("unexpected"), /not allowlisted/);
});