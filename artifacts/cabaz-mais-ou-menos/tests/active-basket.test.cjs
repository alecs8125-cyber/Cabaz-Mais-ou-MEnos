const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVE_BASKET_STORAGE_KEY,
  createActiveBasketWriter,
  loadActiveBasket,
  serializeActiveBasket,
} = require('../.test-build/lib/active-basket.js');

function createMemoryStorage() {
  const values = new Map();
  const writes = [];
  const removals = [];
  return {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
    async removeItem(key) {
      removals.push(key);
      values.delete(key);
    },
    values,
    writes,
    removals,
  };
}

const mixedLines = [
  {
    productId: 'remote-product-1',
    quantity: 3,
    product: {
      id: 'remote-product-1',
      name: 'Leite',
      brand: 'Marca',
      barcode: '123',
      category: 'Laticínios',
      unit: '1 L',
      active: true,
      isDemo: false,
      demoPriceCents: null,
      currentPrice: 999,
    },
  },
  {
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite meio-gordo 1 L',
    brand: null,
    brandLabel: 'Qualquer marca',
    quantity: 2,
  },
];

test('round-trip guarda identidades e quantidades, sem persistir snapshots nem preços', async () => {
  const storage = createMemoryStorage();
  const serialized = serializeActiveBasket(mixedLines);
  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, serialized);

  const loaded = await loadActiveBasket(storage);
  const document = JSON.parse(serialized);

  assert.deepEqual(document, {
    schemaVersion: 1,
    lines: [
      { kind: 'exact', productId: 'remote-product-1', quantity: 3 },
      {
        kind: 'group',
        groupId: 'group-milk-1l',
        brand: null,
        quantity: 2,
      },
    ],
  });
  assert.equal(serialized.includes('demoPriceCents'), false);
  assert.equal(serialized.includes('currentPrice'), false);
  assert.equal(serialized.includes('barcode'), false);
  assert.equal(serialized.includes('"name":"Leite"'), false);
  assert.equal(serialized.includes('groupName'), false);
  assert.equal(serialized.includes('brandLabel'), false);
  assert.deepEqual(loaded.lines, [
    { kind: 'exact', productId: 'remote-product-1', quantity: 3 },
    {
      kind: 'group',
      groupId: 'group-milk-1l',
      brand: null,
      quantity: 2,
    },
  ]);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.needsRewrite, false);
});

test('migra com segurança campos antigos extra e reserializa apenas os campos permitidos', async () => {
  const storage = createMemoryStorage();
  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    lines: [{
      kind: 'exact',
      productId: 'remote-legacy',
      quantity: 1,
      name: 'Produto remoto',
      demoPriceCents: 249,
    }, {
      kind: 'group',
      groupId: 'group-legacy',
      groupName: 'Nome antigo do grupo',
      brand: 'MIMOSA',
      brandLabel: 'Etiqueta antiga',
      quantity: 2,
    }],
  }));
  storage.values.set('cabaz-mais-ou-menos:saved-baskets:v1', 'named-baskets-stay-untouched');

  const loaded = await loadActiveBasket(storage);

  assert.equal(loaded.needsRewrite, true);
  assert.deepEqual(loaded.lines, [
    { kind: 'exact', productId: 'remote-legacy', quantity: 1 },
    { kind: 'group', groupId: 'group-legacy', brand: 'mimosa', quantity: 2 },
  ]);
  const sanitized = JSON.parse(serializeActiveBasket(loaded.lines));
  assert.deepEqual(sanitized.lines, [
    { kind: 'exact', productId: 'remote-legacy', quantity: 1 },
    { kind: 'group', groupId: 'group-legacy', brand: 'mimosa', quantity: 2 },
  ]);
  assert.equal(storage.values.get('cabaz-mais-ou-menos:saved-baskets:v1'), 'named-baskets-stay-untouched');
});

test('JSON corrompido recupera como cabaz vazio e remove apenas a chave ativa', async () => {
  const storage = createMemoryStorage();
  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, '{broken');
  storage.values.set('cabaz-mais-ou-menos:saved-baskets:v1', 'named-basket-data');
  storage.values.set('cabaz-mais-ou-menos:saved-baskets:v2', 'named-basket-data-v2');

  const loaded = await loadActiveBasket(storage);

  assert.deepEqual(loaded.lines, []);
  assert.equal(loaded.recovered, true);
  assert.deepEqual(storage.removals, [ACTIVE_BASKET_STORAGE_KEY]);
  assert.equal(storage.values.has(ACTIVE_BASKET_STORAGE_KEY), false);
  assert.equal(storage.values.get('cabaz-mais-ou-menos:saved-baskets:v1'), 'named-basket-data');
  assert.equal(storage.values.get('cabaz-mais-ou-menos:saved-baskets:v2'), 'named-basket-data-v2');
});

test('documento com versão incompatível recupera como vazio sem tentar interpretar linhas', async () => {
  const storage = createMemoryStorage();
  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, JSON.stringify({
    schemaVersion: 99,
    lines: [{ kind: 'exact', productId: 'should-not-load', quantity: 2 }],
  }));

  const loaded = await loadActiveBasket(storage);

  assert.deepEqual(loaded.lines, []);
  assert.equal(loaded.recovered, true);
  assert.equal(storage.values.has(ACTIVE_BASKET_STORAGE_KEY), false);
});

test('linhas inválidas, quantidades não positivas e identidades duplicadas são descartadas em conjunto', async () => {
  const storage = createMemoryStorage();
  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    lines: [
      { kind: 'exact', productId: 'duplicate', quantity: 1 },
      { kind: 'exact', productId: 'duplicate', quantity: 2 },
    ],
  }));

  const duplicate = await loadActiveBasket(storage);
  assert.deepEqual(duplicate.lines, []);
  assert.equal(duplicate.recovered, true);

  storage.values.set(ACTIVE_BASKET_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    lines: [{ kind: 'group', groupId: 'group-1', groupName: 'Grupo', brand: null, quantity: 0 }],
  }));
  const invalidQuantity = await loadActiveBasket(storage);
  assert.deepEqual(invalidQuantity.lines, []);
  assert.equal(invalidQuantity.recovered, true);
});

test('chave ausente e cabaz vazio não geram escritas', async () => {
  const storage = createMemoryStorage();
  const loaded = await loadActiveBasket(storage);
  const writer = createActiveBasketWriter(storage, 5);
  writer.setBaseline(loaded.serialized);
  writer.schedule([]);
  await writer.flush();

  assert.deepEqual(loaded.lines, []);
  assert.deepEqual(storage.writes, []);
});

test('escritas adiadas juntam alterações rápidas e flush grava o estado mais recente', async () => {
  const storage = createMemoryStorage();
  const writer = createActiveBasketWriter(storage, 15);
  writer.setBaseline(serializeActiveBasket([]));
  writer.schedule([{ productId: 'demo-1', quantity: 1 }]);
  writer.schedule([{ productId: 'demo-1', quantity: 4 }]);

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(storage.writes.length, 1);
  assert.deepEqual(JSON.parse(storage.writes[0][1]).lines, [
    { kind: 'exact', productId: 'demo-1', quantity: 4 },
  ]);
});

test('flush serializa escritas concorrentes para que uma gravação antiga não vença a nova', async () => {
  const values = new Map();
  const calls = [];
  let releaseFirst;
  const storage = {
    async getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      calls.push(value);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => {
            values.set(key, value);
            resolve();
          };
        });
      }
      values.set(key, value);
      return Promise.resolve();
    },
    async removeItem(key) { values.delete(key); },
  };
  const writer = createActiveBasketWriter(storage, 1000);
  writer.setBaseline(serializeActiveBasket([]));
  writer.schedule([{ productId: 'demo-1', quantity: 1 }]);
  const firstFlush = writer.flush();
  await new Promise((resolve) => setImmediate(resolve));
  writer.schedule([{ productId: 'demo-1', quantity: 2 }]);
  const secondFlush = writer.flush();

  assert.equal(calls.length, 1);
  releaseFirst();
  await Promise.all([firstFlush, secondFlush]);

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(values.get(ACTIVE_BASKET_STORAGE_KEY)).lines, [
    { kind: 'exact', productId: 'demo-1', quantity: 2 },
  ]);
});
