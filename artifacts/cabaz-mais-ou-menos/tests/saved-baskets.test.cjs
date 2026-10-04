const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SAVED_BASKETS_STORAGE_KEY,
  SAVED_BASKETS_V2_STORAGE_KEY,
  EMPTY_SAVED_BASKETS_MESSAGE,
  addSavedBasket,
  createSavedBasket,
  deleteSavedBasketAfterConfirmation,
  loadSavedBaskets,
  parseSavedBaskets,
  renameSavedBasket,
  parseSavedBasketsV2,
  restoreSavedBasket,
} = require('../.test-build/lib/saved-baskets.js');
const { basketReducer, summarizeBasket } = require('../.test-build/lib/basket.js');
const { compareSupabaseBasket } = require('../.test-build/lib/comparison.js');

const products = [
  { id: '96658a83-b64e-423f-9e63-71e60cf9225c', name: 'Leite', quantity: 2 },
  { id: 'd16cb15e-ca96-486f-9ecf-d7c35b206b1d', name: 'Arroz', quantity: 1 },
  { id: '747b89cf-f822-48d0-8ff3-b429a01004ad', name: 'Água', quantity: 3 },
];

function basketWithProducts() {
  let lines = [];
  for (const { id, name, quantity } of products) {
    const product = {
      id, name, brand: null, category: null, unit: null,
      active: true, isDemo: false, demoPriceCents: null,
    };
    lines = basketReducer(lines, { type: 'add', productId: id, product });
    for (let count = 1; count < quantity; count += 1) {
      lines = basketReducer(lines, { type: 'increase', productId: id });
    }
  }
  return lines;
}

function createMemoryStorage() {
  const values = new Map();
  const writes = [];
  return {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
    values,
    writes,
  };
}

test('guarda, altera e carrega Compras da semana com IDs e quantidades, sem preços antigos', async () => {
  const storage = createMemoryStorage();
  const initial = summarizeBasket(basketWithProducts()).items;
  const saved = createSavedBasket(
    'Compras da semana',
    initial,
    '2026-09-30T10:00:00.000Z',
    'saved-weekly',
  );
  await addSavedBasket(storage, saved);

  const storedJson = storage.values.get(SAVED_BASKETS_STORAGE_KEY);
  assert.ok(storedJson);
  assert.equal(storedJson.includes('demoPriceCents'), false);
  assert.deepEqual((await loadSavedBaskets(storage))[0], saved);

  const altered = basketReducer(basketWithProducts(), { type: 'replace', lines: [] });
  assert.deepEqual(altered, []);
  const restored = basketReducer(altered, {
    type: 'replace',
    lines: restoreSavedBasket((await loadSavedBaskets(storage))[0]),
  });
  const restoredItems = summarizeBasket(restored).items;
  assert.deepEqual(
    restoredItems.map(({ product, quantity }) => ({ id: product.id, name: product.name, quantity })),
    [
      { id: products[0].id, name: 'Leite', quantity: 2 },
      { id: products[1].id, name: 'Arroz', quantity: 1 },
      { id: products[2].id, name: 'Água', quantity: 3 },
    ],
  );
  assert.ok(restoredItems.every(({ product, subtotalCents }) => product.demoPriceCents === null && subtotalCents === null));

  const comparisons = compareSupabaseBasket(
    restoredItems,
    [
      { id: 'store-a', name: 'Supermercado Demo A' },
      { id: 'store-e', name: 'Mercearia Demo E' },
    ],
    [
      ...products.map(({ id }, index) => ({
        productId: id, storeId: 'store-a', priceCents: [151, 100, 34][index],
        capturedAt: '2026-09-30T10:00:00.000Z', sourceType: 'test',
      })),
      ...products.map(({ id }, index) => ({
        productId: id, storeId: 'store-e', priceCents: [180, 120, 44][index],
        capturedAt: '2026-09-30T10:00:00.000Z', sourceType: 'test',
      })),
    ],
  );
  assert.deepEqual(
    comparisons.map(({ storeName, totalCents }) => ({ storeName, totalCents })),
    [
      { storeName: 'Supermercado Demo A', totalCents: 504 },
      { storeName: 'Mercearia Demo E', totalCents: 612 },
    ],
  );
});

test('a leitura local rejeita dados corrompidos e não importa campos de preço persistidos', () => {
  assert.throws(() => parseSavedBaskets('{invalid'), /danificada/);
  const parsed = parseSavedBaskets(JSON.stringify([{
    id: 'saved-1',
    name: 'Compras',
    savedAt: '2026-09-30T10:00:00.000Z',
    products: [{
      productId: 'remote-1', name: 'Produto remoto', brand: null,
      category: null, unit: null, isDemo: false, quantity: 1,
      demoPriceCents: 999,
    }],
  }]));
  assert.equal('demoPriceCents' in parsed[0].products[0], false);
});

test('cabazes v1 continuam legíveis sem reescrita automática', async () => {
  const storage = createMemoryStorage();
  const legacyJson = JSON.stringify([{
    id: 'legacy-basket',
    name: 'Cabaz antigo',
    savedAt: '2026-09-30T10:00:00.000Z',
    products: [{
      productId: 'remote-legacy',
      name: 'Produto remoto antigo',
      brand: null,
      category: null,
      unit: null,
      isDemo: false,
      quantity: 2,
    }],
  }]);
  storage.values.set(SAVED_BASKETS_STORAGE_KEY, legacyJson);

  const loaded = await loadSavedBaskets(storage);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].products[0].kind, undefined);
  assert.equal(loaded[0].products[0].productId, 'remote-legacy');
  assert.deepEqual(storage.writes, []);
  assert.equal(storage.values.get(SAVED_BASKETS_STORAGE_KEY), legacyJson);
});

test('v2 guarda e restaura escolhas genéricas e cabazes mistos sem fabricar productId', async () => {
  const storage = createMemoryStorage();
  const legacyJson = JSON.stringify([{
    id: 'legacy-basket',
    name: 'Cabaz antigo',
    savedAt: '2026-09-30T10:00:00.000Z',
    products: [{
      productId: 'remote-legacy', name: 'Produto remoto antigo', brand: null,
      category: null, unit: null, isDemo: false, quantity: 1,
    }],
  }]);
  storage.values.set(SAVED_BASKETS_STORAGE_KEY, legacyJson);

  const exactItem = summarizeBasket(basketWithProducts()).items[0];
  const anyBrandItem = summarizeBasket(basketReducer([], {
    type: 'addGroup',
    group: {
      groupId: 'group-milk-1l',
      groupName: 'Leite Meio-Gordo 1 L',
      brand: null,
    },
  })).items[0];
  const groupItem = summarizeBasket(basketReducer([], {
    type: 'addGroup',
    group: {
      groupId: 'group-milk-1l',
      groupName: 'Leite Meio-Gordo 1 L',
      brand: 'mimosa',
      brandLabel: 'MIMOSA',
    },
  })).items[0];
  const basket = createSavedBasket(
    'Misto',
    [exactItem, anyBrandItem, groupItem],
    '2026-10-01T10:00:00.000Z',
    'mixed-basket',
  );
  const saved = await addSavedBasket(storage, basket);
  const v2Document = JSON.parse(storage.values.get(SAVED_BASKETS_V2_STORAGE_KEY));
  const serializedGroups = v2Document.baskets[0].products.filter((product) => product.kind === 'group');
  const serializedAnyGroup = serializedGroups.find((product) => product.brand === null);
  const serializedGroup = serializedGroups.find((product) => product.brand === 'mimosa');

  assert.equal(v2Document.schemaVersion, 2);
  assert.equal(v2Document.baskets.length, 1);
  assert.equal(serializedGroups.length, 2);
  assert.deepEqual(serializedAnyGroup, {
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: null,
    quantity: 1,
  });
  assert.deepEqual(serializedGroup, {
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: 'mimosa',
    brandLabel: 'MIMOSA',
    quantity: 1,
  });
  assert.equal(Object.hasOwn(serializedGroup, 'productId'), false);
  assert.equal(storage.values.get(SAVED_BASKETS_STORAGE_KEY), legacyJson);
  assert.deepEqual(saved.map((entry) => entry.id), ['mixed-basket', 'legacy-basket']);

  const loaded = (await loadSavedBaskets(storage)).find((entry) => entry.id === basket.id);
  const restored = restoreSavedBasket(loaded);
  const restoredGroup = restored.find((line) => line.kind === 'group' && line.brand === 'mimosa');
  const restoredAnyGroup = restored.find((line) => line.kind === 'group' && line.brand === null);
  assert.equal(Object.hasOwn(restoredAnyGroup, 'productId'), false);
  assert.deepEqual(restoredGroup, {
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: 'mimosa',
    brandLabel: 'MIMOSA',
    quantity: 1,
  });
  assert.equal(Object.hasOwn(restoredGroup, 'productId'), false);
  const restoredItems = summarizeBasket(restored).items;
  const restoredSpecificItem = restoredItems.find(
    (item) => item.kind === 'group' && item.brand === 'mimosa',
  );
  assert.equal(restoredSpecificItem.subtotalCents, null);
  assert.equal(restoredSpecificItem.brandLabel, 'MIMOSA');
  assert.equal(restoredItems.length, 3);

  const renamed = await renameSavedBasket(storage, basket.id, 'Misto atualizado');
  assert.equal(renamed.find((entry) => entry.id === basket.id).name, 'Misto atualizado');
  assert.equal(storage.values.get(SAVED_BASKETS_STORAGE_KEY), legacyJson);
  const afterCancel = await deleteSavedBasketAfterConfirmation(storage, basket.id, false);
  assert.ok(afterCancel.some((entry) => entry.id === basket.id));
  const afterDelete = await deleteSavedBasketAfterConfirmation(storage, basket.id, true);
  assert.deepEqual(afterDelete.map((entry) => entry.id), ['legacy-basket']);
  assert.equal(storage.values.get(SAVED_BASKETS_STORAGE_KEY), legacyJson);
});

test('o parser v2 valida explicitamente as linhas de grupo', () => {
  assert.throws(() => parseSavedBasketsV2(JSON.stringify({
    schemaVersion: 1,
    baskets: [],
  })), /v2.*inválida/);
  assert.throws(() => parseSavedBasketsV2(JSON.stringify({
    schemaVersion: 2,
    baskets: [{
      id: 'invalid-group',
      name: 'Inválido',
      savedAt: '2026-09-30T10:00:00.000Z',
      products: [{
        kind: 'group',
        groupId: 'group-1',
        groupName: 'Leite',
        brand: null,
        productId: 'must-not-exist',
        quantity: 1,
      }],
    }],
  })), /produto de grupo v2 inválido/);
});

test('não guarda nomes vazios, cabazes vazios ou quantidades inválidas', () => {
  assert.throws(() => createSavedBasket('   ', summarizeBasket(basketWithProducts()).items), /nome/);
  assert.throws(() => createSavedBasket('Cabaz vazio', []), /Adiciona produtos/);
  assert.throws(() => createSavedBasket('Quantidade inválida', [
    { product: { ...summarizeBasket(basketWithProducts()).items[0].product }, quantity: 0 },
  ]), /inválidos/);
});

test('renomeia sem alterar ID, produtos ou quantidades e persiste o nome após recarregar', async () => {
  const storage = createMemoryStorage();
  const productsBefore = summarizeBasket(basketWithProducts()).items;
  const original = createSavedBasket(
    'Compras da semana',
    productsBefore,
    '2026-09-30T10:00:00.000Z',
    'weekly-basket',
  );
  await addSavedBasket(storage, original);

  const renamed = await renameSavedBasket(storage, original.id, 'Compras semanais');
  assert.equal(renamed[0].name, 'Compras semanais');
  assert.equal(renamed[0].id, original.id);
  assert.equal(renamed[0].savedAt, original.savedAt);
  assert.deepEqual(renamed[0].products, original.products);

  const restoredAfterReload = (await loadSavedBaskets(storage))[0];
  assert.equal(restoredAfterReload.name, 'Compras semanais');
  assert.equal(restoredAfterReload.id, original.id);
  assert.deepEqual(
    restoreSavedBasket(restoredAfterReload).map(({ productId, quantity }) => [productId, quantity]),
    products.map(({ id, quantity }) => [id, quantity]),
  );
});

test('cancelar não apaga; confirmar apaga e deixa a lista vazia', async () => {
  const storage = createMemoryStorage();
  const original = createSavedBasket(
    'Compras semanais',
    summarizeBasket(basketWithProducts()).items,
    '2026-09-30T10:00:00.000Z',
    'weekly-basket',
  );
  await addSavedBasket(storage, original);

  const afterCancel = await deleteSavedBasketAfterConfirmation(storage, original.id, false);
  assert.deepEqual(afterCancel, [original]);
  assert.deepEqual(await loadSavedBaskets(storage), [original]);

  const afterConfirm = await deleteSavedBasketAfterConfirmation(storage, original.id, true);
  assert.deepEqual(afterConfirm, []);
  assert.deepEqual(await loadSavedBaskets(storage), []);
  assert.equal(EMPTY_SAVED_BASKETS_MESSAGE, 'Ainda não tens cabazes guardados.');
});