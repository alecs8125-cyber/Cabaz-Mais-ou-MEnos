const assert = require('node:assert/strict');
const Module = require('node:module');
const { createClient } = require('@supabase/supabase-js');

const url = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
const publishableKey = (process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
if (!url || !publishableKey || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
  throw new Error('O teste real exige a URL Supabase e a chave pública sb_publishable_ já configuradas.');
}

const originalFetch = global.fetch;
const requestMethods = [];
const readOnlyFetch = async (input, init) => {
  const method = String(init?.method ?? 'GET').toUpperCase();
  requestMethods.push(method);
  if (method !== 'GET') {
    throw new Error(`O teste de integração é somente leitura; bloqueado método ${method}.`);
  }
  const requestUrl = input instanceof Request ? input.url : String(input);
  const path = new URL(requestUrl).pathname;
  try {
    return await Reflect.apply(originalFetch, global, [input, init]);
  } catch (cause) {
    const code = cause && typeof cause === 'object'
      ? cause.code ?? cause.cause?.code ?? cause.name
      : 'network_error';
    throw new Error(`GET ${path} failed (${String(code)}).`);
  }
};
const supabase = createClient(url, publishableKey, {
  db: { schema: 'public' },
  global: { fetch: readOnlyFetch },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/supabase') return { supabase };
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};

let productsService;
let storesService;
let pricesService;
let basket;
let comparison;
let storeChannel;
try {
  productsService = require('../.test-build/services/products.js');
  storesService = require('../.test-build/services/stores.js');
  pricesService = require('../.test-build/services/prices.js');
  basket = require('../.test-build/lib/basket.js');
  comparison = require('../.test-build/lib/comparison.js');
  storeChannel = require('../.test-build/lib/store-channel.js');
} finally {
  Module._load = originalLoad;
}

async function findBananaContinente() {
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await productsService.getProducts({
      query: 'Banana Continente',
      offset,
    });
    const banana = result.products.find(
      (product) => product.name.trim().toLocaleLowerCase('pt-PT') === 'banana continente',
    );
    if (banana) return banana;
    if (result.nextOffset === null) break;
    offset = result.nextOffset;
  }
  throw new Error('services/products não encontrou Banana Continente no catálogo real.');
}

async function findThreeContinenteProductIds(storeId) {
  const { data, error } = await supabase.from('prices')
    .select('product_id')
    .eq('store_id', storeId)
    .eq('source_type', 'continente')
    .eq('currency', 'EUR')
    .eq('verification_status', 'verified')
    .order('captured_at', { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(`Não foi possível selecionar preços Continente reais (${error.code ?? 'query'}).`);
  }
  const productIds = [...new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => row.product_id)
      .filter((id) => typeof id === 'string' && id.length > 0),
  )].slice(0, 3);
  assert.equal(productIds.length, 3, 'O teste real precisa de três produtos Continente distintos.');
  return productIds;
}

async function main() {
  {
    const product = await findBananaContinente();
    assert.equal(product.isDemo, false);
    assert.equal(product.demoPriceCents, null);

    const location = { district: 'Lisboa', municipality: 'Lisboa' };
    const rawStores = await storesService.getStores(location);
    const rawOnline = rawStores.find((store) => store.name === 'Continente Online');
    assert.ok(rawOnline, 'services/stores deve incluir Continente Online para a localização manual.');
    assert.equal(rawOnline.store_type, 'online');
    assert.equal(storeChannel.isContinenteOnline(rawOnline), true);
    for (const field of ['district', 'municipality', 'parish', 'latitude', 'longitude']) {
      assert.ok(
        rawOnline[field] == null,
        `Continente Online não deve conter ${field} preenchido.`,
      );
    }

    const initialLines = basket.basketReducer([], {
      type: 'add',
      productId: product.id,
      product,
    });
    const oneItemBasket = basket.summarizeBasket(initialLines);
    assert.equal(oneItemBasket.items.length, 1);
    assert.equal(oneItemBasket.items[0].product.id, product.id);
    assert.equal(oneItemBasket.items[0].quantity, 1);
    assert.equal(oneItemBasket.items[0].subtotalCents, null);

    const data = await pricesService.getComparisonData([product.id], location);
    const onlineStore = data.stores.find((store) => store.id === rawOnline.id);
    assert.ok(onlineStore, 'services/prices deve manter a loja online no filtro por localização.');
    assert.equal(onlineStore.name, 'Continente Online');
    assert.equal(onlineStore.isOnline, true);
    assert.equal('district' in onlineStore, false);
    assert.equal('municipality' in onlineStore, false);
    assert.equal('distance' in onlineStore, false);

    const price = data.prices.find(
      (entry) => entry.productId === product.id && entry.storeId === onlineStore.id,
    );
    assert.ok(price, 'services/prices deve devolver o preço Continente real e vigente.');
    assert.equal(price.sourceType, 'continente');
    assert.ok(Number.isSafeInteger(price.priceCents) && price.priceCents > 0);
    assert.ok(Number.isFinite(Date.parse(price.capturedAt)));

    const threeProductIds = await findThreeContinenteProductIds(rawOnline.id);
    const threeProductData = await pricesService.getComparisonData(threeProductIds, location);
    const threeProductOnlineStore = threeProductData.stores.find(
      (store) => store.id === rawOnline.id,
    );
    assert.ok(threeProductOnlineStore, 'A loja online deve continuar disponível para três produtos.');
    const threeProductPrices = threeProductIds.map((productId) =>
      threeProductData.prices.find(
        (entry) =>
          entry.productId === productId &&
          entry.storeId === threeProductOnlineStore.id &&
          entry.sourceType === 'continente',
      ),
    );
    assert.ok(
      threeProductPrices.every(
        (entry) => entry && Number.isSafeInteger(entry.priceCents) && entry.priceCents > 0,
      ),
      'services/prices deve devolver um preço Continente válido para cada um dos três produtos.',
    );

    const result = comparison.compareSupabaseBasket(
      oneItemBasket.items,
      data.stores,
      data.prices,
    ).find((store) => store.storeId === onlineStore.id);
    assert.ok(result, 'lib/comparison deve gerar o resultado Continente Online.');
    assert.equal(result.storeName, 'Continente Online');
    assert.equal(result.isOnline, true);
    assert.equal(result.totalCents, price.priceCents);
    assert.equal(result.latestCapturedAt, price.capturedAt);
    assert.equal(result.lines.length, 1);
    assert.deepEqual(result.lines[0], {
      productId: product.id,
      name: product.name,
      quantity: 1,
      unitPriceCents: price.priceCents,
      subtotalCents: price.priceCents,
    });

    const twoItemBasket = basket.summarizeBasket(
      basket.basketReducer(initialLines, {
        type: 'increase',
        productId: product.id,
        product,
      }),
    );
    const twoItemResult = comparison.compareSupabaseBasket(
      twoItemBasket.items,
      data.stores,
      data.prices,
    ).find((store) => store.storeId === onlineStore.id);
    assert.equal(twoItemBasket.items[0].quantity, 2);
    assert.equal(twoItemResult.totalCents, price.priceCents * 2);
    assert.equal(twoItemResult.lines[0].subtotalCents, price.priceCents * 2);

    const expirationBoundary = Date.parse(price.capturedAt) + 36 * 60 * 60 * 1000;
    const expiredData = await pricesService.getComparisonData(
      [product.id],
      location,
      undefined,
      expirationBoundary + 1,
    );
    assert.equal(
      expiredData.prices.some((entry) => entry.productId === product.id),
      false,
      'services/prices não deve devolver o preço real depois dos 36h.',
    );
    const expiredResult = comparison.compareSupabaseBasket(
      oneItemBasket.items,
      expiredData.stores,
      expiredData.prices,
    ).find((store) => store.storeId === onlineStore.id);
    assert.equal(expiredResult.totalCents, null);
    assert.equal(expiredResult.lines[0].subtotalCents, null);

    assert.ok(requestMethods.length > 0);
    assert.ok(requestMethods.every((method) => method === 'GET'));
    console.log(JSON.stringify({
      ok: true,
      readOnly: true,
      product: product.name,
      store: onlineStore.name,
      priceCents: price.priceCents,
      appLogicProductsChecked: threeProductPrices.length,
      appLogicPricesCents: threeProductPrices.map((entry) => entry.priceCents),
      quantityOneTotalCents: result.totalCents,
      quantityTwoTotalCents: twoItemResult.totalCents,
      capturedAt: result.latestCapturedAt,
      locationFilterKeepsOnlineStore: true,
      onlineHasNoPhysicalLocationOrDistance: true,
      detailLineAndSubtotalValidated: true,
      expiredPriceExcludedAt36Hours: true,
      requests: requestMethods.length,
      methods: [...new Set(requestMethods)],
    }, null, 2));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Erro desconhecido no teste de integração.';
  console.error(JSON.stringify({ ok: false, readOnly: true, error: message }));
  process.exitCode = 1;
});