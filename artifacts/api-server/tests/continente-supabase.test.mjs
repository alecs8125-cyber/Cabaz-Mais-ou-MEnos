import assert from "node:assert/strict";
import test from "node:test";
import {
  SupabaseRestReadClient,
} from "../tmp/price-import-test-build/services/price-import/supabase-read.js";
import {
  SupabaseContinenteProductCatalog,
} from "../tmp/price-import-test-build/services/price-import/supabase-continente-catalog.js";

test("o catálogo Continente só consulta public.products por GET, sem mutações", async () => {
  const calls = [];
  const client = new SupabaseRestReadClient(
    {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test-only",
    },
    async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return new Response(JSON.stringify([{
        id: "product-uuid",
        name: "Banana",
        brand: "Continente",
        barcode: null,
        unit: "kg",
        active: true,
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const catalog = await new SupabaseContinenteProductCatalog(client).loadActiveProducts();

  assert.equal(catalog.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/rest/v1/products");
  assert.equal(calls[0].url.searchParams.get("select"), "id,name,brand,barcode,unit,active");
  assert.equal(calls[0].url.searchParams.get("active"), "eq.true");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url.pathname.includes("prices"), false);
  assert.equal(calls[0].url.pathname.includes("stores"), false);
  assert.equal(calls[0].url.pathname.includes("price_history"), false);
});