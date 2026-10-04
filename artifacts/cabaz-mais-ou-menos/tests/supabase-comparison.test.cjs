const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectComparisonProductIds,
  compareSupabaseBasket,
  compareSupabaseBasketWithGroups,
} = require('../.test-build/lib/comparison.js');

const capturedAt = '2026-09-30T14:17:10.617Z';
const stores = [
  { id: 'a', name: 'Supermercado Demo A' },
  { id: 'b', name: 'Supermercado Demo B' },
  { id: 'c', name: 'Minimercado Demo C' },
  { id: 'd', name: 'Mercado Demo D' },
  { id: 'e', name: 'Mercearia Demo E' },
];
const milk = { id: 'milk', name: 'Leite Meio-Gordo 1L', isDemo: false };
const rice = { id: 'rice', name: 'Arroz Carolino 1kg', isDemo: false };
const water = { id: 'water', name: 'Água 1,5L', isDemo: false };
const basket = [
  { product: milk, quantity: 2 },
  { product: rice, quantity: 1 },
  { product: water, quantity: 3 },
];

test('produto Continente sem barcode compara pelo ID exato e preserva canal online', () => {
  const native = { id: 'native', name: 'Produto Continente', brand: 'Continente', barcode: null, category: null, unit: null, active: true, isDemo: false, demoPriceCents: null };
  const result = compareSupabaseBasket([{ product: native, quantity: 2 }], [{ id: 'online', name: 'Continente Online', isOnline: true }], [{
    productId: 'native', storeId: 'online', priceCents: 123, capturedAt, sourceType: 'continente',
  }])[0];
  assert.equal(result.isOnline, true);
  assert.equal(result.storeName, 'Continente Online');
  assert.equal(result.totalCents, 246);
  assert.equal(result.isComplete, true);
  assert.equal('distanceKm' in result, false);
});

test('a comparação preserva a identidade e o aviso de âmbito da referência Auchan', () => {
  const store = {
    id: 'auchan-reference',
    name: 'Auchan Online · referência 2650-435 (Amadora)',
    isOnline: true,
    isRegionalReference: true,
    referenceScopeNote: 'Referência limitada ao código postal 2650-435.',
  };
  const result = compareSupabaseBasket(
    [{ product: milk, quantity: 1 }],
    [store],
    [price(milk.id, store.id, 235)],
  )[0];
  assert.equal(result.storeName, store.name);
  assert.equal(result.isOnline, true);
  assert.equal(result.isRegionalReference, true);
  assert.equal(result.referenceScopeNote, store.referenceScopeNote);
  assert.equal('distanceKm' in result, false);
});
const price = (productId, storeId, priceCents, date = capturedAt) => ({
  productId, storeId, priceCents, capturedAt: date, sourceType: 'demo',
});
const prices = [
  ...[89, 101, 114, 97, 107].map((cents, i) => price(milk.id, stores[i].id, cents)),
  ...[149, 161, 174, 157, 167].map((cents, i) => price(rice.id, stores[i].id, cents)),
  ...[59, 71, 84, 67, 77].map((cents, i) => price(water.id, stores[i].id, cents)),
];
const groupLine = (overrides = {}) => ({
  kind: 'group',
  groupId: 'group-milk-1l',
  groupName: 'Leite Meio-Gordo 1 L',
  brand: null,
  quantity: 1,
  subtotalCents: null,
  ...overrides,
});
const member = (id, name, brand) => ({
  id, name, brand, barcode: null, unit: '1 L',
});

test('três produtos, quantidades e cinco lojas: totais conferem com as contas manuais', () => {
  const results = compareSupabaseBasket(basket, stores, prices);
  assert.deepEqual(results.map(({ storeId, totalCents }) => [storeId, totalCents]), [
    ['a', 504], ['d', 552], ['b', 576], ['e', 612], ['c', 654],
  ]);
  assert.ok(results.every((result) =>
    result.foundProducts === 3 && result.missingProducts === 0 &&
    result.isComplete && result.latestCapturedAt === capturedAt));
  assert.deepEqual(results[0].lines.map(({ subtotalCents }) => subtotalCents), [178, 149, 177]);
  assert.equal(results[0].savingsCents, 48);
  assert.equal(results[0].savingsReferenceName, 'Mercado Demo D');
  assert.ok(results.slice(1).every((result) => result.savingsCents === 0));
});

test('preços em falta são identificados, nunca substituídos por zero ou pelo catálogo local', () => {
  const results = compareSupabaseBasket(basket, stores.slice(0, 2), [price('milk', 'a', 89)]);
  assert.equal(results[0].totalCents, 178);
  assert.equal(results[0].foundProducts, 1);
  assert.equal(results[0].missingProducts, 2);
  assert.equal(results[0].isComplete, false);
  assert.deepEqual(results[0].lines.filter((line) => line.subtotalCents === null).map((line) => line.name),
    ['Arroz Carolino 1kg', 'Água 1,5L']);
  assert.equal(results[1].totalCents, null);
  assert.equal(results[1].missingProducts, 3);
  assert.equal(results[0].savingsCents, 0);
  assert.equal(results[1].savingsCents, 0);
});

test('um par produto/loja usa o preço verificado capturado mais recentemente', () => {
  const result = compareSupabaseBasket([{ product: milk, quantity: 2 }], stores.slice(0, 1), [
    price('milk', 'a', 140, '2026-09-29T12:00:00Z'),
    price('milk', 'a', 89, capturedAt),
  ])[0];
  assert.equal(result.totalCents, 178);
  assert.equal(result.latestCapturedAt, capturedAt);
  assert.equal(result.lines[0].unitPriceCents, 89);
});

test('quantidades ou preços inválidos não dão origem a totais inventados', () => {
  assert.throws(() => compareSupabaseBasket([{ product: milk, quantity: 0 }], stores, prices), /quantidade/);
  assert.throws(() => compareSupabaseBasket([{ product: milk, quantity: 1 }], stores, [
    price('milk', 'a', 0),
  ]), /preço/);
});

test('qualquer marca escolhe o SKU mais barato por loja, com desempate estável e quantidade', () => {
  const group = groupLine({ quantity: 2 });
  const members = [
    member('sku-z', 'Leite marca Z', 'Marca Z'),
    member('sku-a', 'Leite marca A', 'Marca A'),
    member('sku-b', 'Leite marca B', 'Marca B'),
  ];
  const results = compareSupabaseBasketWithGroups(
    [group],
    stores.slice(0, 2),
    [
      price('sku-z', 'a', 50),
      price('sku-a', 'a', 50),
      price('sku-b', 'a', 80),
      price('sku-z', 'b', 90),
      price('sku-a', 'b', 75),
      price('sku-b', 'b', 45),
    ],
    { 'group-milk-1l': members },
  );
  const byStore = Object.fromEntries(results.map((result) => [result.storeId, result]));

  assert.equal(byStore.a.totalCents, 100);
  assert.equal(byStore.a.lines[0].productId, 'sku-a');
  assert.equal(byStore.a.lines[0].chosenProductName, 'Leite marca A');
  assert.equal(byStore.a.lines[0].chosenProductBrand, 'Marca A');
  assert.equal(byStore.a.lines[0].requestedBrandLabel, 'Qualquer marca');
  assert.equal(byStore.a.lines[0].quantity, 2);
  assert.equal(byStore.a.lines[0].subtotalCents, 100);
  assert.equal(byStore.b.totalCents, 90);
  assert.equal(byStore.b.lines[0].productId, 'sku-b');
  assert.ok(results.every((result) =>
    result.isComplete && result.requestedProducts === 1 && result.foundProducts === 1));
  assert.equal(Object.hasOwn(group, 'productId'), false);
});

test('marca específica usa igualdade normalizada exata, sem correspondências parciais ou divisão', () => {
  const items = [groupLine({ brand: 'mimosa', brandLabel: 'Mimosa' })];
  const members = [
    member('mimosa-spaces', 'Leite Mimosa', '  MIMOSA '),
    member('mimosa-case', 'Leite Mimosa clássico', 'Mimosa'),
    member('mimosa-light', 'Leite Mimosa Light', 'Mimosa Light'),
    member('compound', 'Leite da marca composta', 'Mimosa,Outra'),
    member('continente', 'Leite Continente', 'Continente'),
    member('continente-compound', 'Leite Continente Sonae', 'Continente,SONAE'),
  ];
  const results = compareSupabaseBasketWithGroups(
    items,
    stores.slice(0, 1),
    [
      price('mimosa-spaces', 'a', 85),
      price('mimosa-case', 'a', 80),
      price('mimosa-light', 'a', 1),
      price('compound', 'a', 2),
    ],
    { 'group-milk-1l': members },
  );

  assert.equal(results[0].lines[0].productId, 'mimosa-case');
  assert.equal(results[0].lines[0].requestedBrandLabel, 'Mimosa');

  const compoundOnly = compareSupabaseBasketWithGroups(
    [groupLine({ brand: 'continente,sonae', brandLabel: 'Continente,SONAE' })],
    stores.slice(0, 1),
    [price('continente', 'a', 1), price('continente-compound', 'a', 70)],
    { 'group-milk-1l': members },
  );
  assert.equal(compoundOnly[0].lines[0].productId, 'continente-compound');
});

test('grupo vazio ou sem membros da marca escolhida conta como linha em falta', () => {
  const empty = compareSupabaseBasketWithGroups(
    [groupLine()],
    stores.slice(0, 1),
    [],
    { 'group-milk-1l': [] },
  )[0];
  assert.equal(empty.totalCents, null);
  assert.equal(empty.foundProducts, 0);
  assert.equal(empty.missingProducts, 1);
  assert.equal(empty.requestedProducts, 1);
  assert.equal(empty.isComplete, false);
  assert.equal(empty.lines[0].kind, 'group');
  assert.equal(empty.lines[0].productId, undefined);
  assert.equal(empty.lines[0].subtotalCents, null);

  const noBrandMatch = compareSupabaseBasketWithGroups(
    [groupLine({ brand: 'mimosa', brandLabel: 'Mimosa' })],
    stores.slice(0, 1),
    [price('other-brand', 'a', 1)],
    { 'group-milk-1l': [member('other-brand', 'Leite de outra marca', 'Outra')] },
  )[0];
  assert.equal(noBrandMatch.totalCents, null);
  assert.equal(noBrandMatch.missingProducts, 1);
  assert.equal(noBrandMatch.lines[0].productId, undefined);
});

test('preço ausente de todos os candidatos nunca cria subtotal nem completa uma linha genérica', () => {
  const result = compareSupabaseBasketWithGroups(
    [groupLine()],
    stores.slice(0, 1),
    [],
    { 'group-milk-1l': [member('sku-without-price', 'Leite real', 'Marca')] },
  )[0];

  assert.equal(result.totalCents, null);
  assert.equal(result.lines[0].unitPriceCents, null);
  assert.equal(result.lines[0].subtotalCents, null);
  assert.equal(result.isComplete, false);
});

test('cabaz misto junta linhas exatas e genéricas; lojas completas precedem totais parciais', () => {
  const exactItem = { product: rice, quantity: 1 };
  const genericItem = groupLine({ quantity: 2 });
  const items = [exactItem, genericItem];
  const result = compareSupabaseBasketWithGroups(
    items,
    stores.slice(0, 2),
    [
      price('rice', 'a', 100),
      price('rice', 'b', 100),
      price('sku-milk', 'b', 75),
    ],
    { 'group-milk-1l': [member('sku-milk', 'Leite real 1 L', 'Marca')] },
  );
  const byStore = Object.fromEntries(result.map((entry) => [entry.storeId, entry]));

  assert.deepEqual(result.map((entry) => entry.storeId), ['b', 'a']);
  assert.equal(byStore.a.totalCents, 100);
  assert.equal(byStore.a.foundProducts, 1);
  assert.equal(byStore.a.missingProducts, 1);
  assert.equal(byStore.a.isComplete, false);
  assert.equal(byStore.b.totalCents, 250);
  assert.equal(byStore.b.foundProducts, 2);
  assert.equal(byStore.b.missingProducts, 0);
  assert.equal(byStore.b.isComplete, true);
  assert.ok(result.every((entry) => entry.savingsCents === 0));
  assert.equal(genericItem.productId, undefined);
});

test('productIds exatos e candidatos são deduplicados numa única lista e excluem produtos demo', () => {
  const candidateAlreadyExact = { id: 'sku-a', name: 'A', isDemo: false };
  const localDemo = { id: 'demo-only', name: 'Demonstração', isDemo: true };
  const ids = collectComparisonProductIds(
    [
      { product: milk, quantity: 1 },
      { product: candidateAlreadyExact, quantity: 1 },
      { product: localDemo, quantity: 1 },
      groupLine(),
    ],
    {
      'group-milk-1l': [
        member('sku-z', 'Produto Z', 'Marca'),
        member('sku-a', 'Produto A', 'Marca'),
      ],
    },
  );

  assert.deepEqual(ids, ['milk', 'sku-a', 'sku-z']);
});

test('27 candidatos sem preço contam como uma linha em falta, sem SKUs ou preço fictício', () => {
  const candidates = Array.from({ length: 27 }, (_, index) =>
    member(`sku-${String(index + 1).padStart(2, '0')}`, `Produto ${index + 1}`, 'Marca'));
  const result = compareSupabaseBasketWithGroups(
    [groupLine()],
    stores.slice(0, 1),
    [],
    { 'group-milk-1l': candidates },
  )[0];

  assert.equal(result.requestedProducts, 1);
  assert.equal(result.foundProducts, 0);
  assert.equal(result.missingProducts, 1);
  assert.equal(result.totalCents, null);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].kind, 'group');
  assert.equal(result.lines[0].productId, undefined);
  assert.equal(result.lines[0].unitPriceCents, null);
  assert.equal(result.lines[0].subtotalCents, null);
});

test('quantity 5 mantém uma linha e escolhe pelo menor preço unitário antes do subtotal', () => {
  const result = compareSupabaseBasketWithGroups(
    [groupLine({ quantity: 5 })],
    stores.slice(0, 1),
    [
      price('sku-expensive', 'a', 89),
      price('sku-cheapest', 'a', 42),
    ],
    {
      'group-milk-1l': [
        member('sku-expensive', 'Leite mais caro', 'Marca A'),
        member('sku-cheapest', 'Leite mais barato', 'Marca B'),
      ],
    },
  )[0];

  assert.equal(result.requestedProducts, 1);
  assert.equal(result.foundProducts, 1);
  assert.equal(result.missingProducts, 0);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].productId, 'sku-cheapest');
  assert.equal(result.lines[0].unitPriceCents, 42);
  assert.equal(result.lines[0].quantity, 5);
  assert.equal(result.lines[0].subtotalCents, 210);
  assert.equal(result.totalCents, 210);
});

test('cabaz misto com dois produtos exatos e um ProductGroup conta três linhas', () => {
  const items = [
    { product: rice, quantity: 1 },
    groupLine({ quantity: 2 }),
    { product: water, quantity: 1 },
  ];
  const results = compareSupabaseBasketWithGroups(
    items,
    stores.slice(0, 2),
    [
      price('rice', 'a', 100),
      price('sku-milk', 'a', 75),
      price('water', 'a', 200),
      price('rice', 'b', 120),
      price('water', 'b', 210),
    ],
    { 'group-milk-1l': [member('sku-milk', 'Leite real 1 L', 'Marca')] },
  );
  const byStore = Object.fromEntries(results.map((result) => [result.storeId, result]));

  assert.equal(byStore.a.requestedProducts, 3);
  assert.equal(byStore.a.foundProducts, 3);
  assert.equal(byStore.a.missingProducts, 0);
  assert.equal(byStore.a.foundProducts + byStore.a.missingProducts, 3);
  assert.equal(byStore.a.lines.length, 3);
  assert.equal(byStore.a.lines.filter((line) => line.kind === 'group').length, 1);
  assert.deepEqual(
    byStore.a.lines.filter((line) => line.kind !== 'group').map((line) => line.productId).sort(),
    ['rice', 'water'],
  );
  assert.equal(byStore.a.totalCents, 450);
  assert.equal(byStore.a.lines.find((line) => line.kind === 'group').subtotalCents, 150);

  assert.equal(byStore.b.requestedProducts, 3);
  assert.equal(byStore.b.foundProducts, 2);
  assert.equal(byStore.b.missingProducts, 1);
  assert.equal(byStore.b.foundProducts + byStore.b.missingProducts, 3);
  assert.equal(byStore.b.lines.length, 3);
  assert.equal(byStore.b.totalCents, 330);
  assert.equal(byStore.b.lines.find((line) => line.kind === 'group').subtotalCents, null);
});

test('candidatos sobrepostos entre dois ProductGroups são consultados uma vez e calculados por linha', () => {
  const items = [
    groupLine({ groupId: 'group-one', groupName: 'Grupo um' }),
    groupLine({ groupId: 'group-two', groupName: 'Grupo dois', quantity: 2 }),
  ];
  const membersByGroupId = {
    'group-one': [
      member('shared-sku', 'Produto partilhado', 'Marca'),
      member('sku-one', 'Produto exclusivo do grupo um', 'Marca'),
    ],
    'group-two': [
      member('shared-sku', 'Produto partilhado', 'Marca'),
      member('sku-two', 'Produto exclusivo do grupo dois', 'Marca'),
    ],
  };
  const ids = collectComparisonProductIds(items, membersByGroupId);
  const priceRows = [
    price('shared-sku', 'a', 60),
    price('sku-one', 'a', 70),
    price('sku-two', 'a', 80),
  ];
  const result = compareSupabaseBasketWithGroups(
    items,
    stores.slice(0, 1),
    priceRows,
    membersByGroupId,
  )[0];

  assert.deepEqual(ids, ['shared-sku', 'sku-one', 'sku-two']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(priceRows.filter((row) => row.productId === 'shared-sku').length, 1);
  assert.equal(result.requestedProducts, 2);
  assert.equal(result.foundProducts, 2);
  assert.equal(result.missingProducts, 0);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines.map((line) => line.kind), ['group', 'group']);
  assert.deepEqual(result.lines.map((line) => line.productId), ['shared-sku', 'shared-sku']);
  assert.deepEqual(result.lines.map((line) => line.subtotalCents), [60, 120]);
  assert.equal(result.totalCents, 180);
});

test('com ProductGroups uma loja completa a 10 € precede uma incompleta a 5 €', () => {
  const result = compareSupabaseBasketWithGroups(
    [{ product: milk, quantity: 1 }, groupLine()],
    stores.slice(0, 2),
    [
      price('milk', 'a', 800),
      price('sku-milk', 'a', 200),
      price('milk', 'b', 500),
    ],
    { 'group-milk-1l': [member('sku-milk', 'Leite real 1 L', 'Marca')] },
  );

  assert.deepEqual(result.map((entry) => entry.storeId), ['a', 'b']);
  assert.equal(result[0].totalCents, 1000);
  assert.equal(result[0].isComplete, true);
  assert.equal(result[1].totalCents, 500);
  assert.equal(result[1].isComplete, false);
  assert.equal(result[1].missingProducts, 1);
});