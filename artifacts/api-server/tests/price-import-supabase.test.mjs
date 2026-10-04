import assert from "node:assert/strict";
import test from "node:test";
import {
  SupabaseRestReadClient,
} from "../tmp/price-import-test-build/services/price-import/supabase-read.js";
import {
  SupabasePriceImportLookup,
} from "../tmp/price-import-test-build/services/price-import/supabase-lookup.js";

function jsonResponse(rows, status = 200) {
  return new Response(JSON.stringify(rows), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("produto é consultado por barcode textual exato e só por GET", async () => {
  const calls = [];
  const client = new SupabaseRestReadClient(
    {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test-only",
    },
    async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return jsonResponse([
        { id: "product-1", barcode: "0005601234567", active: true },
      ]);
    },
  );
  const lookup = new SupabasePriceImportLookup(client);

  const matches = await lookup.findActiveProductsByExactBarcode(" 0005601234567 ");

  assert.deepEqual(matches, [
    { id: "product-1", barcode: "0005601234567", active: true },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/rest/v1/products");
  assert.equal(calls[0].url.searchParams.get("select"), "id,barcode,active");
  assert.equal(calls[0].url.searchParams.get("active"), "eq.true");
  assert.equal(
    calls[0].url.searchParams.get("barcode"),
    "eq.0005601234567",
  );
  assert.equal(calls[0].url.searchParams.get("limit"), "2");
  assert.equal(calls[0].url.searchParams.has("ilike"), false);
  assert.equal(calls[0].url.searchParams.has("or"), false);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    new Headers(calls[0].init.headers).get("apikey"),
    "sb_publishable_test-only",
  );
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
});

test("loja é consultada pela combinação exata de source_type e external_id", async () => {
  const calls = [];
  const client = new SupabaseRestReadClient(
    {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test-only",
    },
    async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return jsonResponse([
        {
          id: "store-1",
          source_type: "openstreetmap",
          external_id: "node/123-ABC",
          active: true,
        },
      ]);
    },
  );
  const lookup = new SupabasePriceImportLookup(client);

  const matches = await lookup.findStoresByExternalId(
    "openstreetmap",
    " node/123-ABC ",
  );

  assert.deepEqual(matches, [
    {
      storeId: "store-1",
      sourceType: "openstreetmap",
      externalStoreId: "node/123-ABC",
      active: true,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/rest/v1/stores");
  assert.equal(
    calls[0].url.searchParams.get("source_type"),
    "eq.openstreetmap",
  );
  assert.equal(
    calls[0].url.searchParams.get("external_id"),
    "eq.node/123-ABC",
  );
  assert.equal(calls[0].url.searchParams.get("active"), "eq.true");
  assert.equal(calls[0].url.searchParams.get("limit"), "2");
  assert.equal(calls[0].init.method, "GET");
});

test("o cliente só aceita chave publicável e não tenta novamente em erro HTTP", async () => {
  assert.throws(
    () =>
      new SupabaseRestReadClient({
        url: "https://example.supabase.co",
        publishableKey: ["sb_", "secret_not-allowed"].join(""),
      }),
    /sb_publishable_/,
  );

  let attempts = 0;
  const client = new SupabaseRestReadClient(
    {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test-only",
    },
    async () => {
      attempts += 1;
      return jsonResponse({ message: "backend detail" }, 503);
    },
  );

  await assert.rejects(client.getRows("products", { select: "id" }), /HTTP 503/);
  assert.equal(attempts, 1);
});