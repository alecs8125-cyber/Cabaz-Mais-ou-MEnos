import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenPricesAdapter,
} from "../tmp/price-import-test-build/services/price-import/open-prices-adapter.js";

function page(items, pageNumber, pages = 1, total = items.length) {
  return {
    items,
    page: pageNumber,
    pages,
    size: 100,
    total,
  };
}

function portugalLocation({
  id,
  osmType = "NODE",
  osmId,
  countryCode = "PT",
} = {}) {
  return {
    id,
    type: "OSM",
    osm_type: osmType,
    osm_id: osmId,
    osm_address_country_code: countryCode,
  };
}

function priceRecord({
  id,
  locationId,
  osmType = "NODE",
  osmId,
  date = "2026-10-01",
  created = "2026-10-01T10:00:00.000Z",
  productCode = "0005601234567",
  price = 1.23,
  countryCode = "PT",
  priceIsDiscounted = false,
  priceWithoutDiscount = null,
} = {}) {
  return {
    id,
    location_id: locationId,
    location: {
      id: locationId,
      type: "OSM",
      osm_type: osmType,
      osm_id: osmId,
      osm_address_country_code: countryCode,
    },
    type: "PRODUCT",
    product_code: productCode,
    price,
    price_is_discounted: priceIsDiscounted,
    price_without_discount: priceWithoutDiscount,
    currency: "EUR",
    date,
    created,
  };
}

test("lê só GETs, filtra Portugal e mapeia OSM para o identificador exato da loja", async () => {
  const calls = [];
  const adapter = new OpenPricesAdapter({
    apiBaseUrl: "https://prices.example.test/api/v1",
    fetchImplementation: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname.endsWith("/locations")) {
        if (url.searchParams.get("page") === "2") {
          return Response.json(page([
            portugalLocation({
              id: 3,
              osmType: "RELATION",
              osmId: 789,
              countryCode: "ES",
            }),
            portugalLocation({
              id: 4,
              osmType: "RELATION",
              osmId: 790,
            }),
          ], 2, 2, 4));
        }
        return Response.json(page([
          portugalLocation({ id: 1, osmType: "NODE", osmId: 123 }),
          portugalLocation({ id: 2, osmType: "WAY", osmId: 456 }),
        ], 1, 2, 3));
      }
      return Response.json(page([
        priceRecord({ id: 11, locationId: 1, osmId: 123 }),
        priceRecord({
          id: 12,
          locationId: 2,
          osmType: "WAY",
          osmId: 456,
          date: "2026-09-30",
          priceIsDiscounted: true,
          priceWithoutDiscount: 1.79,
        }),
        priceRecord({
          id: 13,
          locationId: 3,
          osmType: "RELATION",
          osmId: 789,
          countryCode: "ES",
        }),
        priceRecord({
          id: 14,
          locationId: 4,
          osmType: "RELATION",
          osmId: 790,
        }),
      ], 1, 1, 4));
    },
  });

  const observations = await adapter.fetchObservations();

  assert.equal(adapter.sourceType, "open_prices");
  assert.equal(adapter.mode, "external");
  assert.equal(adapter.requiresValidUntil, false);
  assert.equal(adapter.validityWindowDays, 7);
  assert.equal(observations.length, 3);
  assert.deepEqual(
    observations.map((item) => [
      item.externalId,
      item.externalStoreId,
      item.storeMappingUnverified,
    ]),
    [
      ["14", null, true],
      ["11", "n123", false],
      ["12", null, true],
    ],
  );
  assert.equal(observations[0].barcode, "0005601234567");
  assert.equal(observations[0].validUntil, null);
  assert.equal(observations[0].sourceStoreOsmType, "RELATION");
  assert.equal(observations[0].sourceStoreOsmId, "790");
  assert.equal(observations[2].priceIsDiscounted, true);
  assert.equal(observations[2].priceWithoutDiscount, 1.79);
  assert.equal(observations[2].promotion, "discounted");
  assert.equal(observations[2].sourceStoreOsmType, "WAY");
  assert.equal(observations[2].sourceStoreOsmId, "456");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(new Headers(call.init.headers).get("authorization"), null);
  }
  const locationCall = calls.find((call) => call.url.pathname.endsWith("/locations"));
  assert.equal(locationCall.url.searchParams.get("osm_address_country__like"), "Portugal");
  assert.equal(locationCall.url.searchParams.get("price_count__gte"), "1");
  const priceCall = calls.find((call) => call.url.pathname.endsWith("/prices"));
  assert.equal(priceCall.url.searchParams.get("location_id__in"), "1,2,4");
  assert.equal(priceCall.url.searchParams.get("type"), "PRODUCT");
  assert.equal(priceCall.url.searchParams.get("product_code__isnull"), "false");
  assert.equal(priceCall.url.searchParams.get("currency"), "EUR");
  assert.equal(priceCall.url.searchParams.get("size"), "100");
  assert.equal(priceCall.url.searchParams.get("order_by"), "-date,-created");
});

test("combina lotes de locais, ordena preços recentes e nunca ultrapassa 100", async () => {
  const locations = Array.from({ length: 101 }, (_, index) =>
    portugalLocation({
      id: index + 1,
      osmType: "NODE",
      osmId: index + 1000,
    })
  );
  const priceCalls = [];
  const adapter = new OpenPricesAdapter({
    apiBaseUrl: "https://prices.example.test/api/v1",
    fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/locations")) {
        const pageNumber = Number(url.searchParams.get("page"));
        return Response.json(page(
          pageNumber === 1 ? locations.slice(0, 100) : locations.slice(100),
          pageNumber,
          2,
          101,
        ));
      }

      const ids = url.searchParams.get("location_id__in").split(",");
      priceCalls.push(ids.length);
      const records = ids.map((locationId, index) => {
        const numericId = Number(locationId);
        return priceRecord({
          id: numericId,
          locationId: numericId,
          osmId: numericId + 999,
          date: ids.length === 1
            ? "2026-09-30"
            : "2026-09-01",
          created: `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        });
      });
      return Response.json(page(records, 1, 2, 150));
    },
  });

  const observations = await adapter.fetchObservations();

  assert.deepEqual(priceCalls, [100, 1]);
  assert.equal(observations.length, 100);
  assert.equal(observations[0].capturedAt, "2026-09-30");
});

test("falha explicitamente perante resposta HTTP não bem-sucedida", async () => {
  const adapter = new OpenPricesAdapter({
    apiBaseUrl: "https://prices.example.test/api/v1",
    fetchImplementation: async () => new Response("unavailable", { status: 503 }),
  });

  await assert.rejects(adapter.fetchObservations(), /HTTP 503/);
});