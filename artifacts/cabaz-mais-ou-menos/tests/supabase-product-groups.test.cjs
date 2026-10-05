const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const calls = [];
let respond = () => ({ data: [], error: null, count: 0 });

function makeQuery() {
  const query = { operations: [] };
  for (const method of ['select', 'eq', 'order', 'or', 'range', 'in', 'retry']) {
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
let groupService;
let productService;
try {
  groupService = require('../.test-build/services/product-groups.js');
  productService = require('../.test-build/services/products.js');
} finally {
  Module._load = originalLoad;
}

function setup(responder) {
  calls.length = 0;
  respond = responder;
}

const groupRow = (overrides = {}) => ({
  id: 'group-milk-half-fat-1l',
  name: 'Leite Meio-Gordo 1 L',
  product_type: 'Leite',
  variant: 'Meio-Gordo',
  package_quantity: 1,
  package_unit: 'l',
  ...overrides,
});

const operation = (query, name) => query.operations.find(([method]) => method === name);

test('getProductGroups reads only the requested columns from active public groups in stable order', async () => {
  setup(() => ({ data: [groupRow()], error: null }));

  const groups = await groupService.getProductGroups();

  assert.equal(calls.length, 1);
  const query = calls[0];
  assert.deepEqual(operation(query, 'schema'), ['schema', 'public']);
  assert.deepEqual(operation(query, 'from'), ['from', 'product_groups']);
  assert.deepEqual(operation(query, 'select'), [
    'select',
    'id,name,product_type,variant,package_quantity,package_unit',
  ]);
  assert.deepEqual(operation(query, 'eq'), ['eq', 'active', true]);
  assert.deepEqual(query.operations.filter(([method]) => method === 'order'), [
    ['order', 'product_type', { ascending: true }],
    ['order', 'variant', { ascending: true }],
    ['order', 'package_quantity', { ascending: true }],
    ['order', 'package_unit', { ascending: true }],
    ['order', 'id', { ascending: true }],
  ]);
  assert.deepEqual(operation(query, 'retry'), ['retry', false]);
  assert.ok(operation(query, 'abortSignal')[1] instanceof AbortSignal);
  assert.deepEqual(groups, [{
    id: 'group-milk-half-fat-1l',
    name: 'Leite Meio-Gordo 1 L',
    productType: 'Leite',
    variant: 'Meio-Gordo',
    packageQuantity: 1,
    packageUnit: 'l',
  }]);
});

test('getProductGroups accepts an empty result and reports Supabase and malformed-row errors', async (t) => {
  await t.test('empty result', async () => {
    setup(() => ({ data: [], error: null }));
    assert.deepEqual(await groupService.getProductGroups(), []);
  });

  await t.test('Supabase error', async () => {
    setup(() => ({ data: null, error: { code: '42501', message: 'group access denied' } }));
    await assert.rejects(groupService.getProductGroups(), /42501.*group access denied/);
  });

  await t.test('invalid group row', async () => {
    setup(() => ({ data: [groupRow({ package_quantity: '1' })], error: null }));
    await assert.rejects(groupService.getProductGroups(), /grupo de produtos inválido/);
  });

  await t.test('non-array result', async () => {
    setup(() => ({ data: null, error: null }));
    await assert.rejects(groupService.getProductGroups(), /lista de grupos inválida/);
  });
});

test('group options support the Leite → Meio-Gordo → 1 L selection path', () => {
  const options = require('../.test-build/lib/product-group-options.js');
  const groups = [
    {
      id: 'group-milk-half-fat-1l',
      name: 'Leite Meio-Gordo 1 L',
      productType: 'Leite',
      variant: 'Meio-Gordo',
      packageQuantity: 1,
      packageUnit: 'l',
    },
    {
      id: 'group-water-1l',
      name: 'Água 1 L',
      productType: 'Água',
      variant: 'Natural',
      packageQuantity: 1,
      packageUnit: 'l',
    },
  ];

  assert.deepEqual(options.getProductTypes(groups), ['Água', 'Leite']);
  assert.deepEqual(options.getProductVariants(groups, 'Leite'), ['Meio-Gordo']);
  const packageOptions = options.getGroupsForVariant(groups, 'Leite', 'Meio-Gordo');
  assert.equal(packageOptions.length, 1);
  assert.equal(options.formatProductGroupPackage(packageOptions[0]), '1 L');
  assert.equal(packageOptions[0].name, 'Leite Meio-Gordo 1 L');
});

test('group members load only linked active products and request only the required fields', async () => {
  const members = [{
    id: 'product-mimosa',
    name: 'Leite Meio-Gordo Mimosa 1 L',
    brand: 'Mimosa',
    barcode: '5601234567890',
    unit: '1 L',
  }];
  setup((query) => {
    const table = operation(query, 'from')?.[1];
    if (table === 'product_group_items') {
      return { data: [{ product_id: 'product-mimosa' }, { product_id: 'product-mimosa' }], error: null };
    }
    return { data: members, error: null };
  });

  const result = await groupService.getProductGroupMembers('group-milk-half-fat-1l');

  assert.deepEqual(result, members);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((query) => operation(query, 'from')[1]), [
    'product_group_items',
    'products',
  ]);
  assert.deepEqual(operation(calls[0], 'select'), ['select', 'product_id']);
  assert.deepEqual(operation(calls[0], 'eq'), ['eq', 'group_id', 'group-milk-half-fat-1l']);
  assert.deepEqual(operation(calls[0], 'order'), ['order', 'product_id', { ascending: true }]);
  assert.deepEqual(operation(calls[1], 'select'), ['select', 'id,name,brand,barcode,unit']);
  assert.deepEqual(operation(calls[1], 'in'), ['in', 'id', ['product-mimosa']]);
  assert.deepEqual(calls[1].operations.filter(([method]) => method === 'eq'), [
    ['eq', 'active', true],
  ]);
  for (const query of calls) {
    assert.deepEqual(operation(query, 'retry'), ['retry', false]);
    assert.ok(operation(query, 'abortSignal')[1] instanceof AbortSignal);
  }
});

test('an empty group returns no members and does not query products', async () => {
  setup(() => ({ data: [], error: null }));

  assert.deepEqual(await groupService.getProductGroupMembers('group-empty'), []);
  assert.equal(calls.length, 1);
  assert.deepEqual(operation(calls[0], 'from'), ['from', 'product_group_items']);
});

test('group member reads report membership, product, and malformed-row errors', async (t) => {
  await t.test('membership query error', async () => {
    setup(() => ({ data: null, error: { code: '42501', message: 'membership access denied' } }));
    await assert.rejects(
      groupService.getProductGroupMembers('group-1'),
      /42501.*membership access denied/,
    );
    assert.equal(calls.length, 1);
  });

  await t.test('product query error', async () => {
    setup((query) => {
      if (operation(query, 'from')[1] === 'product_group_items') {
        return { data: [{ product_id: 'product-1' }], error: null };
      }
      return { data: null, error: { code: 'PGRST116', message: 'product query failed' } };
    });
    await assert.rejects(
      groupService.getProductGroupMembers('group-1'),
      /PGRST116.*product query failed/,
    );
  });

  await t.test('malformed member ID', async () => {
    setup(() => ({ data: [{ product_id: null }], error: null }));
    await assert.rejects(
      groupService.getProductGroupMembers('group-1'),
      /ID de produto inválido/,
    );
  });

  await t.test('malformed product row', async () => {
    setup((query) => operation(query, 'from')[1] === 'product_group_items'
      ? { data: [{ product_id: 'product-1' }], error: null }
      : { data: [{ id: 'product-1', name: 'Milk', brand: 5, barcode: null, unit: null }], error: null });
    await assert.rejects(
      groupService.getProductGroupMembers('group-1'),
      /produto do grupo inválido/,
    );
  });
});

test('group metadata resolves current brands and active linked products without price fields', async () => {
  setup((query) => {
    if (operation(query, 'from')[1] === 'product_group_items') {
      return {
        data: [
          { group_id: 'group-a', product_id: 'product-2' },
          { group_id: 'group-b', product_id: 'product-1' },
          { group_id: 'group-a', product_id: 'product-1' },
        ],
        error: null,
      };
    }
    return {
      data: [
        { id: 'product-2', name: 'Leite Meio-Gordo Mimosa 1 L', brand: 'Mimosa' },
        { id: 'product-1', name: 'Leite Meio-Gordo Mimosa 500 ml', brand: ' MIMOSA ' },
      ],
      error: null,
    };
  });

  const metadata = await groupService.getProductGroupCatalogMetadata([
    'group-b',
    'group-a',
    'group-a',
  ]);

  assert.deepEqual(metadata, {
    availableGroupIds: ['group-a', 'group-b'],
    brandLabels: [
    { groupId: 'group-a', brand: 'mimosa', label: 'MIMOSA' },
    { groupId: 'group-b', brand: 'mimosa', label: 'MIMOSA' },
    ],
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((query) => operation(query, 'from')[1]), [
    'product_group_items',
    'products',
  ]);
  assert.deepEqual(operation(calls[0], 'select'), ['select', 'group_id,product_id']);
  assert.deepEqual(operation(calls[0], 'in'), ['in', 'group_id', ['group-b', 'group-a']]);
  assert.deepEqual(operation(calls[1], 'select'), ['select', 'id,name,brand']);
  assert.deepEqual(operation(calls[1], 'eq'), ['eq', 'active', true]);
  for (const query of calls) {
    assert.deepEqual(operation(query, 'retry'), ['retry', false]);
    assert.ok(operation(query, 'abortSignal')[1] instanceof AbortSignal);
  }
});

test('group metadata omits deactivated products while retaining valid unbranded active members', async () => {
  setup((query) => {
    if (operation(query, 'from')[1] === 'product_group_items') {
      return {
        data: [
          { group_id: 'group-no-longer-available', product_id: 'product-inactive' },
          { group_id: 'group-current', product_id: 'product-active-unbranded' },
        ],
        error: null,
      };
    }
    return {
      data: [{
        id: 'product-active-unbranded',
        name: 'Produto sem marca',
        brand: null,
      }],
      error: null,
    };
  });

  const metadata = await groupService.getProductGroupCatalogMetadata([
    'group-no-longer-available',
    'group-current',
  ]);

  assert.deepEqual(metadata, {
    availableGroupIds: ['group-current'],
    brandLabels: [],
  });
  assert.deepEqual(operation(calls[1], 'select'), ['select', 'id,name,brand']);
  assert.deepEqual(operation(calls[1], 'eq'), ['eq', 'active', true]);
});

test('group metadata skips empty input, batches IDs, and propagates invalid responses', async (t) => {
  await t.test('empty input makes no query', async () => {
    setup(() => ({ data: [], error: null }));
    assert.deepEqual(await groupService.getProductGroupCatalogMetadata([]), {
      availableGroupIds: [],
      brandLabels: [],
    });
    assert.equal(calls.length, 0);
  });

  await t.test('long ID lists are batched', async () => {
    setup(() => ({ data: [], error: null }));
    const ids = Array.from({ length: 101 }, (_, index) => `group-${index}`);
    assert.deepEqual(await groupService.getProductGroupCatalogMetadata(ids), {
      availableGroupIds: [],
      brandLabels: [],
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(operation(calls[0], 'in'), ['in', 'group_id', ids.slice(0, 100)]);
    assert.deepEqual(operation(calls[1], 'in'), ['in', 'group_id', ids.slice(100)]);
  });

  await t.test('malformed membership row rejects explicitly', async () => {
    setup(() => ({ data: [{ group_id: 'group-1', product_id: null }], error: null }));
    await assert.rejects(
      groupService.getProductGroupCatalogMetadata(['group-1']),
      /relação de grupo inválida/,
    );
  });

  await t.test('product query errors remain explicit', async () => {
    setup((query) => operation(query, 'from')[1] === 'product_group_items'
      ? { data: [{ group_id: 'group-1', product_id: 'product-1' }], error: null }
      : { data: null, error: { code: '42501', message: 'brand lookup denied' } });
    await assert.rejects(
      groupService.getProductGroupCatalogMetadata(['group-1']),
      /42501.*brand lookup denied/,
    );
  });
});

test('brand options trim and deduplicate case-insensitively without splitting comma values', () => {
  const options = require('../.test-build/lib/product-group-options.js');
  const brandOptions = options.getProductGroupBrandOptions([
    { id: '1', name: 'A', brand: ' MIMOSA ', barcode: null, unit: '1 L' },
    { id: '2', name: 'B', brand: 'Mimosa', barcode: null, unit: '1 L' },
    { id: '3', name: 'C', brand: 'Continente', barcode: null, unit: '1 L' },
    { id: '4', name: 'D', brand: 'Continente,SONAE', barcode: null, unit: '1 L' },
    { id: '5', name: 'E', brand: 'Milbona,Lidl', barcode: null, unit: '1 L' },
    { id: '6', name: 'F', brand: 'Nova Açores,Unileite', barcode: null, unit: '1 L' },
    { id: '7', name: 'G', brand: '   ', barcode: null, unit: '1 L' },
    { id: '8', name: 'H', brand: null, barcode: null, unit: '1 L' },
  ]);

  assert.equal(brandOptions[0].kind, 'any');
  assert.equal(brandOptions[0].value, null);
  assert.equal(brandOptions[0].label, 'Qualquer marca');
  assert.equal(brandOptions.filter((option) => option.value === 'mimosa').length, 1);
  assert.equal(brandOptions.find((option) => option.value === 'mimosa').label, 'MIMOSA');
  assert.ok(brandOptions.some((option) => option.value === 'continente'));
  assert.ok(brandOptions.some((option) => option.value === 'continente,sonae'));
  assert.ok(brandOptions.some((option) => option.value === 'milbona,lidl'));
  assert.ok(brandOptions.some((option) => option.value === 'nova açores,unileite'));
  assert.equal(brandOptions.length, 6);
  assert.equal(options.getProductGroupBrandOptions([])[0].label, 'Qualquer marca');
});

test('any-brand candidates include every member and a selected brand matches the full normalized value', () => {
  const options = require('../.test-build/lib/product-group-options.js');
  const members = [
    { id: 'mimosa', name: 'Milk Mimosa', brand: ' MIMOSA ', barcode: null, unit: '1 L' },
    { id: 'mimosa-other-case', name: 'Milk Mimosa', brand: 'Mimosa', barcode: null, unit: '1 L' },
    { id: 'mimosa-light', name: 'Milk Mimosa Light', brand: 'Mimosa Light', barcode: null, unit: '1 L' },
    { id: 'compound', name: 'Milk compound', brand: 'Mimosa,Outra', barcode: null, unit: '1 L' },
    { id: 'no-brand', name: 'Milk without brand', brand: null, barcode: null, unit: '1 L' },
  ];

  assert.deepEqual(
    options.getProductGroupCandidatesForBrand(members, null).map(({ id }) => id),
    ['mimosa', 'mimosa-other-case', 'mimosa-light', 'compound', 'no-brand'],
  );
  assert.deepEqual(
    options.getProductGroupCandidatesForBrand(members, 'mimosa').map(({ id }) => id),
    ['mimosa', 'mimosa-other-case'],
  );
  assert.deepEqual(
    options.getProductGroupCandidatesForBrand(members, 'mimosa,outra').map(({ id }) => id),
    ['compound'],
  );
});

test('local group selections store only groupId and a normalized brand value', () => {
  const options = require('../.test-build/lib/product-group-options.js');
  const [anyBrand, mimosa] = options.getProductGroupBrandOptions([
    { id: 'product-1', name: 'Milk', brand: 'MIMOSA', barcode: null, unit: '1 L' },
  ]);
  const anySelection = options.createProductGroupSelection('group-1', anyBrand);
  const brandSelection = options.createProductGroupSelection('group-1', mimosa);

  assert.deepEqual(anySelection, { kind: 'group', groupId: 'group-1', brand: null });
  assert.deepEqual(brandSelection, { kind: 'group', groupId: 'group-1', brand: 'mimosa' });
  assert.equal(Object.hasOwn(anySelection, 'product_id'), false);
  assert.equal(Object.hasOwn(brandSelection, 'product_id'), false);
  assert.equal(Object.hasOwn(anySelection, 'productId'), false);
  assert.equal(Object.hasOwn(brandSelection, 'productId'), false);
});

test('a member-query failure does not prevent the exact-product query', async () => {
  const exactProduct = {
    id: 'product-exact-1',
    name: 'Leite Meio-Gordo Mimosa 1 L',
    brand: 'Mimosa',
    barcode: null,
    category: 'Leite',
    unit: '1 L',
    active: true,
  };
  setup((query) => {
    const table = operation(query, 'from')?.[1];
    if (table === 'product_group_items') {
      return { data: null, error: { code: '42501', message: 'membership access denied' } };
    }
    return { data: [exactProduct], error: null, count: 1 };
  });

  await assert.rejects(
    groupService.getProductGroupMembers('group-1'),
    /42501.*membership access denied/,
  );
  const page = await productService.getProducts({ query: 'Mimosa' });

  assert.equal(page.products.length, 1);
  assert.equal(page.products[0].id, exactProduct.id);
  assert.equal(page.products[0].name, exactProduct.name);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((query) => operation(query, 'from')[1]), [
    'product_group_items',
    'products',
  ]);
});