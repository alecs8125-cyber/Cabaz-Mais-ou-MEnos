const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const calls = [];
let respond = () => ({ data: [], error: null });

function makeQuery() {
  const query = { operations: [] };
  for (const method of ['select', 'eq', 'order', 'ilike', 'or', 'range', 'not', 'limit', 'gt', 'retry']) {
    query[method] = (...args) => {
      query.operations.push([method, ...args]);
      return query;
    };
  }
  query.abortSignal = (signal) => {
    query.operations.push(['abortSignal', signal]);
    return query;
  };
  query.then = (resolve, reject) => Promise.resolve(respond(query)).then(resolve, reject);
  return query;
}

const supabase = {
  schema(name) {
    return {
      from(table) {
        const query = makeQuery();
        query.operations.unshift(['from', table]);
        query.operations.unshift(['schema', name]);
        calls.push(query);
        return query;
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/supabase') return { supabase };
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
let service;
try {
  service = require('../.test-build/services/products.js');
} finally {
  Module._load = originalLoad;
}

function setup(responder) {
  calls.length = 0;
  respond = responder;
}

const product = (overrides = {}) => ({
  id: 'product-1',
  name: 'A product',
  brand: 'A brand',
  barcode: null,
  category: 'Food',
  unit: '1 kg',
  active: true,
  ...overrides,
});

const operations = (query) => query.operations.map(([method, ...args]) => [method, ...args]);
const operation = (query, name) => query.operations.find(([method]) => method === name);

test('source-native sem barcode/formato aparece por nome ou marca na pesquisa normal', async () => {
  const native = product({ id: 'continente-native', name: 'Mini Tostas', brand: 'Continente', barcode: null, category: null, unit: null });
  for (const query of ['Mini Tostas', 'Continente']) {
    setup(() => ({ data: [native], error: null, count: 1 }));
    const page = await service.getProducts({ query });
    assert.equal(page.products[0].id, native.id);
    assert.equal(page.products[0].barcode, null);
    assert.equal(page.products[0].unit, null);
    assert.match(operation(calls[0], 'or')[1], /name\.ilike.*brand\.ilike/);
    assert.equal(calls[0].operations.some(([method, field]) => method === 'not' && field === 'barcode'), false);
  }
});

test('getProducts reads only active public products, orders stably, and requests at most 20 rows', async () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    product({ id: `id-${index}`, name: `Product ${index}` }),
  );
  setup(() => ({ data: rows, error: null, count: 61 }));

  const page = await service.getProducts({ category: 'Food', offset: 40 });

  assert.equal(calls.length, 1);
  const query = calls[0];
  assert.deepEqual(operation(query, 'schema'), ['schema', 'public']);
  assert.deepEqual(operation(query, 'from'), ['from', 'products']);
  assert.deepEqual(operation(query, 'select'), [
    'select',
    'id,name,brand,barcode,category,unit,active',
    { count: 'exact' },
  ]);
  assert.deepEqual(query.operations.filter(([method]) => method === 'eq'), [
    ['eq', 'active', true],
    ['eq', 'category', 'Food'],
  ]);
  assert.deepEqual(query.operations.filter(([method]) => method === 'order'), [
    ['order', 'name', { ascending: true }],
    ['order', 'id', { ascending: true }],
  ]);
  assert.deepEqual(operation(query, 'range'), ['range', 40, 59]);
  assert.deepEqual(operation(query, 'retry'), ['retry', false]);
  assert.ok(operation(query, 'abortSignal')[1] instanceof AbortSignal);
  assert.equal(page.products.length, 20);
  assert.equal(page.nextOffset, 60);
  assert.deepEqual(page.products[0], {
    id: 'id-0',
    name: 'Product 0',
    brand: 'A brand',
    barcode: null,
    category: 'Food',
    unit: '1 kg',
    active: true,
    isDemo: false,
    demoPriceCents: null,
  });
});

test('getProducts searches name and brand by substring and barcode by exact value, combined with category', async () => {
  const barcode = '5601234567890';
  setup(() => ({ data: [product({ barcode })], error: null, count: 1 }));

  const page = await service.getProducts({ query: barcode, category: 'Food' });

  assert.deepEqual(operation(calls[0], 'select'), [
    'select',
    'id,name,brand,barcode,category,unit,active',
    { count: 'exact' },
  ]);
  assert.deepEqual(operation(calls[0], 'or'), [
    'or',
    `name.ilike.${JSON.stringify(`%${barcode}%`)},brand.ilike.${JSON.stringify(`%${barcode}%`)},barcode.eq.${JSON.stringify(barcode)}`,
  ]);
  assert.deepEqual(calls[0].operations.filter(([method]) => method === 'eq'), [
    ['eq', 'active', true],
    ['eq', 'category', 'Food'],
  ]);
  assert.equal(page.products[0].barcode, barcode);
  assert.equal(page.nextOffset, null);
});

test('getProducts safely quotes search values and escapes LIKE wildcards', async () => {
  const query = '  milk%_\\, "powder"  ';
  const normalized = 'milk%_\\, "powder"';
  const pattern = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
  setup(() => ({ data: [], error: null, count: 0 }));

  await service.getProducts({ query });

  assert.deepEqual(operation(calls[0], 'or'), [
    'or',
    `name.ilike.${JSON.stringify(pattern)},brand.ilike.${JSON.stringify(pattern)},barcode.eq.${JSON.stringify(normalized)}`,
  ]);
});

test('empty product pages are valid and nullable fields stay null without invented demo prices', async () => {
  setup(() => ({ data: [product({ brand: null, barcode: null, category: null, unit: null })], error: null, count: 1 }));

  const page = await service.getProducts();

  assert.equal(operation(calls[0], 'range')[1], 0);
  assert.equal(operation(calls[0], 'range')[2], 19);
  assert.deepEqual(page, {
    products: [{
      id: 'product-1',
      name: 'A product',
      brand: null,
      barcode: null,
      category: null,
      unit: null,
      active: true,
      isDemo: false,
      demoPriceCents: null,
    }],
    nextOffset: null,
  });

  setup(() => ({ data: [], error: null, count: 0 }));
  assert.deepEqual(await service.getProducts(), { products: [], nextOffset: null });
});

test('getProducts hides the next-page state when an exact full page is the final page', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => product({ id: `id-${index}` }));
  setup(() => ({ data: rows, error: null, count: 60 }));

  const page = await service.getProducts({ offset: 40 });

  assert.equal(page.products.length, 20);
  assert.equal(page.nextOffset, null);
  assert.deepEqual(operation(calls[0], 'range'), ['range', 40, 59]);
});

test('getProducts preserves Supabase error code and message and never falls back to local data', async () => {
  setup(() => ({ data: null, error: { code: 'PGRST116', message: 'catalog query failed' } }));

  await assert.rejects(
    service.getProducts(),
    /PGRST116.*catalog query failed/,
  );
  assert.equal(calls.length, 1);
});

test('getProducts rejects malformed responses and inactive or invalid product rows', async (t) => {
  await t.test('non-array result', async () => {
    setup(() => ({ data: null, error: null, count: 0 }));
    await assert.rejects(service.getProducts(), /resposta inválida/);
  });
  await t.test('inactive row', async () => {
    setup(() => ({ data: [product({ active: false })], error: null, count: 1 }));
    await assert.rejects(service.getProducts(), /campos inválidos/);
  });
  await t.test('invalid nullable field type', async () => {
    setup(() => ({ data: [product({ unit: 3 })], error: null, count: 1 }));
    await assert.rejects(service.getProducts(), /campos inválidos/);
  });
  await t.test('invalid barcode type', async () => {
    setup(() => ({ data: [product({ barcode: 560123 })], error: null, count: 1 }));
    await assert.rejects(service.getProducts(), /campos inválidos/);
  });
  await t.test('null row', async () => {
    setup(() => ({ data: [null], error: null, count: 1 }));
    await assert.rejects(service.getProducts(), /campos inválidos/);
  });
});

test('getProductCategories selects only active non-null categories and pages past repeated rows', async () => {
  const pages = [
    Array.from({ length: 100 }, () => ({ category: 'Banana' })),
    Array.from({ length: 100 }, () => ({ category: 'Maçã' })),
    [
      { category: 'Água' },
      { category: 'Açúcar' },
      { category: 'Banana' },
      { category: '   ' },
    ],
  ];
  setup(() => ({ data: pages.shift(), error: null }));

  const categories = await service.getProductCategories();

  assert.equal(calls.length, 3);
  for (const [index, query] of calls.entries()) {
    assert.deepEqual(operation(query, 'schema'), ['schema', 'public']);
    assert.deepEqual(operation(query, 'from'), ['from', 'products']);
    assert.deepEqual(operation(query, 'select'), ['select', 'category']);
    assert.deepEqual(operation(query, 'eq'), ['eq', 'active', true]);
    assert.deepEqual(operation(query, 'not'), ['not', 'category', 'is', null]);
    assert.deepEqual(operation(query, 'order'), ['order', 'category', { ascending: true }]);
    assert.deepEqual(operation(query, 'limit'), ['limit', 100]);
    assert.deepEqual(operation(query, 'retry'), ['retry', false]);
    assert.ok(operation(query, 'abortSignal')[1] instanceof AbortSignal);
    if (index === 0) assert.equal(operation(query, 'gt'), undefined);
  }
  assert.deepEqual(operation(calls[1], 'gt'), ['gt', 'category', 'Banana']);
  assert.deepEqual(operation(calls[2], 'gt'), ['gt', 'category', 'Maçã']);
  assert.deepEqual(
    categories,
    ['Água', 'Açúcar', 'Banana', 'Maçã'].sort((a, b) => a.localeCompare(b, 'pt-PT')),
  );
});

test('getProductCategories propagates Supabase errors and rejects invalid rows', async (t) => {
  await t.test('preserves error code and message without local fallback', async () => {
    setup(() => ({ data: null, error: { code: '42501', message: 'category access denied' } }));
    await assert.rejects(
      service.getProductCategories(),
      /42501.*category access denied/,
    );
    assert.equal(calls.length, 1);
  });
  await t.test('rejects a non-string category', async () => {
    setup(() => ({ data: [{ category: null }], error: null }));
    await assert.rejects(service.getProductCategories(), /categorias inválidas/);
  });
  await t.test('rejects a null row', async () => {
    setup(() => ({ data: [null], error: null }));
    await assert.rejects(service.getProductCategories());
  });
});

test('Home product pages append all fetched products in order and deduplicate by id', () => {
  const firstPage = Array.from({ length: 20 }, (_, index) => ({ id: `product-${index}` }));
  const secondPage = [
    firstPage[19],
    ...Array.from({ length: 20 }, (_, index) => ({ id: `product-${index + 20}` })),
  ];
  const merged = require('../.test-build/lib/product-pages.js').mergeUniqueProductPages([
    { products: firstPage },
    { products: secondPage },
  ]);

  assert.equal(merged.length, 40);
  assert.equal(merged[8].id, 'product-8');
  assert.equal(merged[39].id, 'product-39');
  assert.equal(new Set(merged.map(({ id }) => id)).size, merged.length);
});