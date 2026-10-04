const test = require('node:test');
const assert = require('node:assert/strict');
const { DEMO_PRODUCTS } = require('../.test-build/data/demo-products.js');
const { DEMO_STORES } = require('../.test-build/data/demo-stores.js');
const { compareBasket, hasProductGroupBasketItems } = require('../.test-build/lib/comparison.js');
const { summarizeBasket } = require('../.test-build/lib/basket.js');
const { getDemoProduct, formatDemoPrice } = require('../.test-build/lib/products.js');

const milk = 'leite-meio-gordo';
const rice = 'arroz-agulha';
const basket = (...lines) => summarizeBasket(
  lines.map(([productId, quantity]) => ({ productId, quantity })),
).items;
const store = (id, name, prices) => ({ id, name, isDemo: true, demoPricesCents: prices });
const resultById = (results, id) => results.find((result) => result.storeId === id);

test('identifica linhas por grupo sem alterar o cálculo de cabazes apenas com produtos exatos', () => {
  const groupItem = {
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: null,
    quantity: 1,
    subtotalCents: null,
  };
  const exactItems = basket([milk, 1]);

  assert.equal(hasProductGroupBasketItems([groupItem]), true);
  assert.equal(hasProductGroupBasketItems(exactItems), false);
  assert.equal(compareBasket(exactItems).length, DEMO_STORES.length);
});

test('produto remoto é marcado em falta, sem preço inventado ou validação no catálogo demo', () => {
  const remote = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Leite meio-gordo',
    brand: null,
    category: null,
    unit: null,
    active: true,
    isDemo: false,
    demoPriceCents: null,
  };
  const remoteItems = summarizeBasket([{ productId: remote.id, product: remote, quantity: 2 }]).items;
  const onlyRemote = compareBasket(remoteItems);
  assert.equal(onlyRemote.length, DEMO_STORES.length);
  assert.ok(onlyRemote.every((r) =>
    r.totalCents === null && r.foundProducts === 0 && r.missingProducts === 1 &&
    !r.isComplete && r.savingsCents === 0,
  ));
  const mixed = compareBasket([...remoteItems, ...basket([milk, 1])]);
  assert.ok(mixed.every((r) => r.requestedProducts === 2 && r.missingProducts >= 1 && !r.isComplete));
  assert.equal(resultById(mixed, 'supermercado-a').totalCents, 99);
  assert.ok(mixed.every((r) => r.savingsCents === 0));
});

test('as cinco lojas fictícias têm preços locais distintos para os produtos disponíveis', () => {
  assert.deepEqual(DEMO_STORES.map((s) => s.name), [
    'Supermercado A', 'Supermercado B', 'Supermercado C', 'Minimercado D', 'Mercado E',
  ]);
  assert.equal(new Set(DEMO_STORES.map((s) => s.id)).size, 5);
  const productIds = DEMO_PRODUCTS.map((p) => p.id).sort();
  for (const s of DEMO_STORES) {
    assert.equal(s.isDemo, true);
    assert.deepEqual(Object.keys(s.demoPricesCents).sort(), productIds);
    for (const price of Object.values(s.demoPricesCents)) {
      assert.ok(price === null || (Number.isSafeInteger(price) && price > 0));
    }
  }
  for (const p of DEMO_PRODUCTS) {
    const prices = DEMO_STORES.map((s) => s.demoPricesCents[p.id]).filter((v) => v !== null);
    assert.ok(prices.length >= 2);
    assert.equal(new Set(prices).size, prices.length, `preços distintos: ${p.id}`);
  }
});

test('calcula 2 leites + 1 arroz por loja e ordena pelo total crescente', () => {
  const results = compareBasket(basket([milk, 2], [rice, 1]));
  assert.deepEqual(results.map((r) => [r.storeName, r.totalCents]), [
    ['Mercado E', 119],
    ['Supermercado A', 327],
    ['Supermercado C', 367],
    ['Supermercado B', 377],
    ['Minimercado D', 417],
  ]);
  const best = resultById(results, 'supermercado-a');
  assert.equal(best.foundProducts, 2);
  assert.equal(best.missingProducts, 0);
  assert.equal(best.requestedProducts, 2);
  assert.equal(best.isComplete, true);
  assert.equal(best.savingsCents, 40);
  assert.equal(best.savingsReferenceName, 'Supermercado C');
});

test('produtos em falta não usam preços do catálogo nem criam uma poupança fictícia', () => {
  const partial = resultById(compareBasket(basket([milk, 2], [rice, 1])), 'mercado-e');
  assert.equal(partial.totalCents, 119);
  assert.equal(partial.foundProducts, 1);
  assert.equal(partial.missingProducts, 1);
  assert.equal(partial.requestedProducts, 2);
  assert.equal(partial.isComplete, false);
  assert.equal(partial.savingsCents, 0);
  assert.equal(partial.savingsReferenceName, null);
});

test('conta produtos distintos, multiplica quantidades e agrega linhas repetidas', () => {
  const separate = compareBasket(basket([milk, 2], [milk, 3], [rice, 2]));
  const combined = compareBasket(basket([milk, 5], [rice, 2]));
  assert.deepEqual(separate, combined);
  const a = resultById(separate, 'supermercado-a');
  assert.equal(a.requestedProducts, 2);
  assert.equal(a.totalCents, 753); // 5 × 99 + 2 × 129
});

test('a contagem de encontrados + em falta corresponde ao cabaz completo de 24 produtos', () => {
  const items = basket(...DEMO_PRODUCTS.map((p, i) => [p.id, i % 3 + 1]));
  const results = compareBasket(items);
  for (const result of results) {
    assert.equal(result.requestedProducts, 24);
    assert.equal(result.foundProducts + result.missingProducts, 24);
    const s = DEMO_STORES.find((entry) => entry.id === result.storeId);
    const availableItems = items.filter((item) => s.demoPricesCents[item.product.id] !== null);
    const expected = availableItems.reduce(
      (sum, item) => sum + item.quantity * s.demoPricesCents[item.product.id], 0,
    );
    assert.equal(result.totalCents, expected);
    assert.equal(result.foundProducts, availableItems.length);
  }
  assert.equal(resultById(results, 'supermercado-a').missingProducts, 0);
  assert.equal(resultById(results, 'supermercado-b').missingProducts, 0);
  assert.equal(resultById(results, 'supermercado-c').missingProducts, 2);
  assert.equal(resultById(results, 'minimercado-d').missingProducts, 5);
  assert.equal(resultById(results, 'mercado-e').missingProducts, 12);
});

test('sem qualquer produto encontrado, o total é indisponível e a loja fica no fim', () => {
  const results = compareBasket(basket([milk, 1]));
  const missing = results.at(-1);
  assert.equal(missing.storeName, 'Mercado E');
  assert.equal(missing.totalCents, null);
  assert.equal(missing.foundProducts, 0);
  assert.equal(missing.missingProducts, 1);
  assert.equal(missing.savingsCents, 0);
});

test('um cabaz vazio não produz ofertas nem poupanças', () => {
  assert.deepEqual(compareBasket([]), []);
});

test('37,85 € face a 39,20 € dá uma poupança exata de 1,35 €', () => {
  const results = compareBasket(basket([milk, 1]), [
    store('b', 'Supermercado B', { [milk]: 3920 }),
    store('a', 'Supermercado A', { [milk]: 3785 }),
  ]);
  assert.equal(results[0].savingsCents, 135);
  assert.equal(results[0].savingsReferenceName, 'Supermercado B');
  assert.equal(formatDemoPrice(results[0].savingsCents).replace(/\s/g, ''), '1,35€');
  assert.equal(results[1].savingsCents, 0);
});

test('compara poupanças apenas entre cabazes completos, nunca contra um total parcial', () => {
  const results = compareBasket(basket([milk, 1], [rice, 1]), [
    store('a', 'A', { [milk]: 100, [rice]: 100 }),
    store('b', 'B', { [milk]: 500, [rice]: null }),
    store('c', 'C', {}),
  ]);
  assert.ok(results.every((r) => r.savingsCents === 0 && r.savingsReferenceName === null));
});

test('se todas as lojas tiverem produtos em falta, não calcula poupanças', () => {
  const results = compareBasket(basket([milk, 1], [rice, 1]), [
    store('a', 'A', { [milk]: 100 }),
    store('b', 'B', { [rice]: 300 }),
  ]);
  assert.ok(results.every((r) => !r.isComplete && r.savingsCents === 0));
});

test('preços iguais não geram uma diferença de preço e os empates ordenam pelo nome', () => {
  const results = compareBasket(basket([milk, 1]), [
    store('b', 'Supermercado B', { [milk]: 199 }),
    store('a', 'Supermercado A', { [milk]: 199 }),
  ]);
  assert.deepEqual(results.map((r) => r.storeName), ['Supermercado A', 'Supermercado B']);
  assert.ok(results.every((r) => r.savingsCents === 0));
});

test('duas lojas empatadas no menor total têm a mesma referência de poupança', () => {
  const results = compareBasket(basket([milk, 1]), [
    store('b', 'B', { [milk]: 199 }),
    store('c', 'C', { [milk]: 250 }),
    store('a', 'A', { [milk]: 199 }),
  ]);
  assert.deepEqual(results.map((r) => [r.storeName, r.savingsCents, r.savingsReferenceName]), [
    ['A', 51, 'C'], ['B', 51, 'C'], ['C', 0, null],
  ]);
});

test('recalcula após alterar quantidades ou remover produtos, sem modificar o cabaz nem preços', () => {
  const items = basket([milk, 2], [rice, 1]);
  items.forEach(Object.freeze);
  Object.freeze(items);
  const before = JSON.stringify({ items, stores: DEMO_STORES, products: DEMO_PRODUCTS });
  compareBasket(items);
  assert.equal(JSON.stringify({ items, stores: DEMO_STORES, products: DEMO_PRODUCTS }), before);
  assert.equal(resultById(compareBasket(basket([milk, 3], [rice, 1])), 'supermercado-a').totalCents, 426);
  assert.equal(resultById(compareBasket(basket([milk, 3])), 'supermercado-a').totalCents, 297);
});

test('rejeita quantidades, preços ou totais inválidos em vez de mostrar valores incorretos', () => {
  for (const quantity of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => compareBasket([{ product: getDemoProduct(milk), quantity }]), /quantidade/);
  }
  for (const price of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(
      () => compareBasket(basket([milk, 1]), [store('x', 'X', { [milk]: price })]),
      /cêntimos/,
    );
  }
  assert.throws(
    () => compareBasket([{ product: getDemoProduct(milk), quantity: Number.MAX_SAFE_INTEGER }]),
    /limite/,
  );
  assert.throws(
    () => compareBasket([
      { product: getDemoProduct(milk), quantity: Number.MAX_SAFE_INTEGER },
      { product: getDemoProduct(milk), quantity: 1 },
    ]),
    /limite/,
  );
  assert.throws(
    () => compareBasket([{ product: { id: 'produto-inexistente' }, quantity: 1 }]),
    /Produto/,
  );
});