const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEMO_PRODUCTS, PRODUCT_CATEGORIES } = require('../.test-build/data/demo-products.js');
const { searchProducts, getDemoProduct, formatDemoPrice } = require('../.test-build/lib/products.js');

test('ações repetidas após remover um produto remoto não fazem lookup no catálogo local', () => {
  const { basketReducer: reduce } = require('../.test-build/lib/basket.js');
  const product = {
    id: 'remote-removed', name: 'Produto remoto', brand: null, category: null,
    unit: null, active: true, isDemo: false, demoPriceCents: null,
  };
  const added = reduce([], { type: 'add', productId: product.id, product });
  const empty = reduce(added, { type: 'remove', productId: product.id });
  for (const type of ['remove', 'increase', 'decrease']) {
    assert.equal(reduce(empty, { type, productId: product.id }), empty);
  }
});
const {
  basketReducer,
  getBasketItemBrandLabel,
  getBasketItemIdentity,
  summarizeBasket,
} = require('../.test-build/lib/basket.js');

const act = (lines, type, productId = 'leite-meio-gordo') =>
  basketReducer(lines, { type, productId });
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

test('produto remoto guarda snapshot e permite adicionar repetidamente, alterar quantidade e remover por ID', () => {
  const original = basketReducer([], { type: 'add', productId: remote.id, product: remote });
  assert.notEqual(original[0].product, remote);
  const twice = basketReducer(original, { type: 'add', productId: remote.id, product: remote });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].quantity, 2);
  assert.deepEqual(summarizeBasket(twice).items[0].product, remote);
  const increased = act(twice, 'increase', remote.id);
  assert.equal(increased[0].quantity, 3);
  const decreased = act(increased, 'decrease', remote.id);
  assert.equal(decreased[0].quantity, 2);
  assert.equal(act(act(decreased, 'decrease', remote.id), 'decrease', remote.id)[0].quantity, 1);
  assert.deepEqual(act(increased, 'remove', remote.id), []);
  assert.equal(original[0].quantity, 1);
});

test('subtotal remoto e total misto sem preço são nulos, sem confundir nomes iguais', () => {
  const remoteLine = basketReducer([], { type: 'add', productId: remote.id, product: remote });
  const summary = summarizeBasket(remoteLine);
  assert.equal(summary.items[0].subtotalCents, null);
  assert.equal(summary.totalCents, null);
  assert.equal(summary.totalQuantity, 1);
  const mixed = summarizeBasket(act(remoteLine, 'add'));
  assert.equal(mixed.totalCents, null);
  assert.equal(mixed.items[1].subtotalCents, 109);
  assert.equal(mixed.totalQuantity, 2);
  assert.equal(summarizeBasket(act(remoteLine, 'remove', remote.id)).totalCents, 0);
});

test('quantidades e totais remotos mantêm limites de inteiros seguros', () => {
  const remoteLine = basketReducer([], { type: 'add', productId: remote.id, product: remote });
  assert.throws(
    () => act([{ ...remoteLine[0], quantity: Number.MAX_SAFE_INTEGER }], 'increase', remote.id),
    /limite/,
  );
  assert.throws(() => summarizeBasket([{ ...remoteLine[0], quantity: 0 }]), /inteiro positivo/);
  assert.throws(
    () => summarizeBasket([{ ...remoteLine[0], quantity: Number.MAX_SAFE_INTEGER }, remoteLine[0]]),
    /limite/,
  );
});

test('linhas exatas antigas sem kind continuam válidas e escolhas genéricas não criam produtos nem preços', () => {
  const legacyLine = { productId: 'leite-meio-gordo', quantity: 2 };
  const restoredLegacy = basketReducer([], { type: 'replace', lines: [legacyLine] });
  assert.deepEqual(restoredLegacy, [legacyLine]);
  assert.equal(summarizeBasket(restoredLegacy).items[0].product.id, legacyLine.productId);
  assert.equal(summarizeBasket(restoredLegacy).items[0].kind, undefined);

  const anyBrand = basketReducer([], {
    type: 'addGroup',
    group: {
      groupId: 'group-milk-1l',
      groupName: 'Leite Meio-Gordo 1 L',
      brand: null,
    },
  });
  const specificBrand = basketReducer([], {
    type: 'addGroup',
    group: {
      groupId: 'group-milk-1l',
      groupName: 'Leite Meio-Gordo 1 L',
      brand: 'mimosa',
      brandLabel: 'MIMOSA',
    },
  });
  assert.deepEqual(anyBrand, [{
    kind: 'group',
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: null,
    quantity: 1,
  }]);
  assert.equal(Object.hasOwn(anyBrand[0], 'productId'), false);
  assert.equal(Object.hasOwn(specificBrand[0], 'productId'), false);
  assert.equal(Object.hasOwn(anyBrand[0], 'product'), false);

  const anyItem = summarizeBasket(anyBrand).items[0];
  const specificItem = summarizeBasket(specificBrand).items[0];
  assert.equal(getBasketItemBrandLabel(anyItem), 'Qualquer marca');
  assert.equal(getBasketItemBrandLabel(specificItem), 'MIMOSA');
  assert.equal(anyItem.subtotalCents, null);
  assert.equal(specificItem.subtotalCents, null);
  assert.equal(summarizeBasket(anyBrand).totalCents, null);
});

test('a identidade groupId + brand agrupa a mesma escolha, separa marcas e aceita os controlos de quantidade', () => {
  const mimosa = {
    groupId: 'group-milk-1l',
    groupName: 'Leite Meio-Gordo 1 L',
    brand: 'mimosa',
    brandLabel: 'MIMOSA',
  };
  let lines = basketReducer([], { type: 'addGroup', group: mimosa });
  lines = basketReducer(lines, {
    type: 'addGroup',
    group: { ...mimosa, brandLabel: 'Mimosa' },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].brandLabel, 'MIMOSA');

  lines = basketReducer(lines, {
    type: 'addGroup',
    group: {
      groupId: 'group-milk-1l',
      groupName: 'Leite Meio-Gordo 1 L',
      brand: 'continente',
      brandLabel: 'Continente',
    },
  });
  assert.equal(lines.length, 2);
  assert.notEqual(
    getBasketItemIdentity(summarizeBasket([lines[0]]).items[0]),
    getBasketItemIdentity(summarizeBasket([lines[1]]).items[0]),
  );

  lines = basketReducer(lines, {
    type: 'increaseGroup',
    groupId: 'group-milk-1l',
    brand: 'mimosa',
  });
  assert.equal(lines[0].quantity, 3);
  lines = basketReducer(lines, {
    type: 'decreaseGroup',
    groupId: 'group-milk-1l',
    brand: 'mimosa',
  });
  assert.equal(lines[0].quantity, 2);
  lines = basketReducer(lines, {
    type: 'decreaseGroup',
    groupId: 'group-milk-1l',
    brand: 'mimosa',
  });
  assert.equal(lines[0].quantity, 1);
  const atMinimum = basketReducer(lines, {
    type: 'decreaseGroup',
    groupId: 'group-milk-1l',
    brand: 'mimosa',
  });
  assert.equal(atMinimum[0].quantity, 1);
  lines = basketReducer(lines, {
    type: 'removeGroup',
    groupId: 'group-milk-1l',
    brand: 'mimosa',
  });
  assert.deepEqual(lines.map((line) => [line.groupId, line.brand, line.quantity]), [
    ['group-milk-1l', 'continente', 1],
  ]);
});

test('cabaz misto mantém subtotais exatos, não dá preço ao grupo e pode ser limpo', () => {
  const exactLines = act([], 'add');
  const groupLines = basketReducer([], {
    type: 'addGroup',
    group: { groupId: 'group-water-1l', groupName: 'Água Natural 1 L', brand: null },
  });
  const mixed = [...exactLines, ...groupLines];
  const summary = summarizeBasket(mixed);
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.totalCents, null);
  assert.equal(summary.items[0].subtotalCents, 109);
  assert.equal(summary.items[1].subtotalCents, null);

  const cleared = basketReducer(mixed, { type: 'replace', lines: [] });
  assert.deepEqual(cleared, []);
  assert.equal(summarizeBasket(cleared).totalCents, 0);
});

test('catálogo local tem pelo menos 20 produtos completos e as oito categorias pedidas', () => {
  assert.ok(DEMO_PRODUCTS.length >= 20);
  assert.equal(new Set(DEMO_PRODUCTS.map((product) => product.id)).size, DEMO_PRODUCTS.length);
  assert.deepEqual(PRODUCT_CATEGORIES, [
    'Leite e derivados', 'Carne', 'Peixe', 'Fruta', 'Legumes', 'Mercearia', 'Bebidas', 'Higiene',
  ]);
  for (const category of PRODUCT_CATEGORIES) {
    assert.ok(DEMO_PRODUCTS.some((product) => product.category === category));
  }
  for (const product of DEMO_PRODUCTS) {
    for (const key of ['id', 'name', 'brand', 'category', 'unit']) assert.ok(product[key].trim());
    assert.ok(PRODUCT_CATEGORIES.includes(product.category));
    assert.ok(Number.isSafeInteger(product.demoPriceCents) && product.demoPriceCents > 0);
    assert.equal(product.isDemo, true);
    assert.match(product.brand, /^Demo /);
  }
});

test('pesquisa vazia mostra o catálogo; pesquisa por nome ignora maiúsculas, acentos e espaços', () => {
  assert.equal(searchProducts('   ').length, DEMO_PRODUCTS.length);
  assert.deepEqual(searchProducts(' LEITE  meio ').map((product) => product.id), ['leite-meio-gordo']);
  assert.deepEqual(searchProducts('maca').map((product) => product.id), ['maca-gala']);
  assert.deepEqual(searchProducts('BROCOLOS').map((product) => product.id), ['brocolos']);
  assert.deepEqual(searchProducts('dentifrica').map((product) => product.id), ['pasta-dentifrica']);
});

test('pesquisa é apenas pelo nome, não pela marca ou categoria; ausência de resultados é válida', () => {
  assert.deepEqual(searchProducts('Demo Láctea'), []);
  assert.deepEqual(searchProducts('Higiene'), []);
  assert.deepEqual(searchProducts('produto inexistente'), []);
});

test('adicionar o mesmo produto aumenta a quantidade sem duplicar a linha', () => {
  const once = act([], 'add');
  const twice = act(once, 'add');
  assert.deepEqual(once, [{ productId: 'leite-meio-gordo', quantity: 1 }]);
  assert.deepEqual(twice, [{ productId: 'leite-meio-gordo', quantity: 2 }]);
  assert.equal(summarizeBasket(twice).items[0].product.unit, '1L');
});

test('aumentar e diminuir recalculam o subtotal sem modificar o estado anterior', () => {
  const once = act([], 'add');
  const twice = act(once, 'increase');
  assert.equal(summarizeBasket(twice).items[0].subtotalCents, 218);
  const reduced = act(twice, 'decrease');
  assert.equal(summarizeBasket(reduced).totalCents, 109);
  assert.equal(twice[0].quantity, 2);
  assert.equal(once[0].quantity, 1);
});

test('diminuir não produz quantidade zero ou negativa; remoção é uma ação explícita', () => {
  const once = act([], 'add');
  assert.equal(act(once, 'decrease'), once);
  assert.deepEqual(act([], 'decrease'), []);
  assert.deepEqual(act([], 'increase'), []);
  assert.deepEqual(act(once, 'remove'), []);
});

test('total soma todos os produtos e quantidades com cêntimos inteiros', () => {
  let lines = act(act([], 'add'), 'increase');
  lines = act(lines, 'add', 'arroz-agulha');
  const summary = summarizeBasket(lines);
  assert.equal(summary.totalCents, 347);
  assert.equal(summary.totalQuantity, 3);
  assert.equal(summary.items.length, 2);
  assert.equal(formatDemoPrice(summary.totalCents).replace(/\s/g, ''), '3,47€');
});

test('remover um produto preserva os outros e o último devolve total zero', () => {
  let lines = act(act([], 'add'), 'add', 'arroz-agulha');
  lines = act(lines, 'remove');
  assert.deepEqual(lines, [{ productId: 'arroz-agulha', quantity: 1 }]);
  assert.equal(summarizeBasket(lines).totalCents, 129);
  lines = act(lines, 'remove', 'arroz-agulha');
  assert.deepEqual(summarizeBasket(lines), { items: [], totalCents: 0, totalQuantity: 0 });
  assert.equal(formatDemoPrice(0).replace(/\s/g, ''), '0,00€');
});

test('todos os produtos do catálogo podem ser adicionados e removidos', () => {
  const filled = DEMO_PRODUCTS.reduce((lines, product) => act(lines, 'add', product.id), []);
  const summary = summarizeBasket(filled);
  assert.equal(summary.items.length, DEMO_PRODUCTS.length);
  assert.equal(summary.totalCents, DEMO_PRODUCTS.reduce((sum, product) => sum + product.demoPriceCents, 0));
  const empty = DEMO_PRODUCTS.reduce((lines, product) => act(lines, 'remove', product.id), filled);
  assert.equal(summarizeBasket(empty).totalCents, 0);
});

test('identificadores e quantidades inválidos falham explicitamente', () => {
  assert.throws(() => getDemoProduct('inexistente'), /desconhecido/);
  assert.throws(() => act([], 'add', 'inexistente'), /desconhecido/);
  for (const quantity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => summarizeBasket([{ productId: 'leite-meio-gordo', quantity }]), /inteiro positivo/);
  }
  for (const cents of [-1, 0.1, NaN, Infinity]) assert.throws(() => formatDemoPrice(cents), /cêntimos/);
});