const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let resolvePage = () => [];
let onlineRows = [];

const supabase = {
  schema(name) {
    calls.push(['schema', name]);
    return {
      from(table) {
        calls.push(['from', table]);
        let pageStart = 0;
        let onlineQuery = false;
        const request = {
          select(...args) {
            calls.push(['select', ...args]);
            return request;
          },
          eq(...args) {
            calls.push(['eq', ...args]);
            if (args[0] === 'external_id' && args[1] === 'online') onlineQuery = true;
            return request;
          },
          ilike(...args) {
            calls.push(['ilike', ...args]);
            return request;
          },
          order(...args) {
            calls.push(['order', ...args]);
            return request;
          },
          range(start, end) {
            calls.push(['range', start, end]);
            pageStart = start;
            return request;
          },
          abortSignal(...args) {
            calls.push(['abortSignal', ...args]);
            return request;
          },
          then(resolve, reject) {
            return Promise.resolve({ data: onlineQuery ? onlineRows : resolvePage(pageStart), error: null })
              .then(resolve, reject);
          },
        };
        return request;
      },
    };
  },
};

const supabasePath = require.resolve('../.test-build/lib/supabase.js');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { supabase },
};

const { getStores } = require('../.test-build/services/stores.js');

function callsFor(method) {
  return calls.filter(([name]) => name === method);
}

function storeRow(id) {
  return {
    id: String(id),
    name: `Loja ${id}`,
    active: true,
    district: 'Faro',
    municipality: 'Loulé',
    parish: 'Quarteira',
  };
}

test('consulta apenas colunas necessárias, lojas ativas e filtros de localização escolhidos', async () => {
  calls.length = 0;
  resolvePage = () => [];

  await getStores({
    district: 'Faro',
    municipality: 'Loulé',
    parish: 'Quarteira',
  });

  assert.deepEqual(callsFor('select'), Array(2).fill(['select', 'id,name,active,district,municipality,parish,source_type,external_id,store_type']));
  assert.ok(callsFor('eq').some(([, field, value]) =>
    field === 'active' && value === true));
  assert.deepEqual(
    callsFor('ilike').map(([, field]) => field),
    ['district', 'municipality', 'parish'],
  );
  assert.ok(callsFor('ilike').some(([, field, pattern]) =>
    field === 'municipality' && pattern.includes('%')));
  assert.deepEqual(callsFor('order'), [['order', 'id', { ascending: true }]]);
  assert.deepEqual(callsFor('range'), [['range', 0, 499], ['range', 0, 1]]);
});

test('aplica filtros progressivamente apenas aos níveis fornecidos', async () => {
  resolvePage = () => [];
  const cases = [
    [{ district: 'Faro' }, ['district']],
    [{ district: 'Faro', municipality: 'Loulé' }, ['district', 'municipality']],
    [{ district: 'Faro', municipality: 'Loulé', parish: 'Quarteira' }, ['district', 'municipality', 'parish']],
  ];

  for (const [selection, expectedFields] of cases) {
    calls.length = 0;
    await getStores(selection);
    assert.deepEqual(
      callsFor('ilike').map(([, field]) => field),
      expectedFields,
    );
    assert.ok(callsFor('eq').some(([, field, value]) =>
      field === 'active' && value === true));
  }
});

test('pagina resultados por ID até devolver todas as lojas correspondentes', async () => {
  calls.length = 0;
  const rows = Array.from({ length: 1001 }, (_, index) => storeRow(index + 1));
  resolvePage = (offset) => rows.slice(offset, offset + 500);

  const result = await getStores({ district: 'Faro' });

  assert.equal(result.length, 1001);
  assert.deepEqual(callsFor('range'), [
    ['range', 0, 499],
    ['range', 500, 999],
    ['range', 1000, 1499],
    ['range', 0, 1],
  ]);
  assert.equal(callsFor('order').length, 3);
});

test('não faz consulta nacional quando não há localização manual', async () => {
  calls.length = 0;
  assert.deepEqual(await getStores(null), []);
  assert.ok(callsFor('eq').some(([, field, value]) => field === 'external_id' && value === 'online'));
  assert.equal(callsFor('ilike').length, 0);
  assert.deepEqual(callsFor('range'), [['range', 0, 1]]);
});

test('Continente Online é consultado exatamente, sem filtros da zona, mesmo sem zona', async () => {
  const online = { id: 'online', name: 'Continente Online', active: true, source_type: 'continente', external_id: 'online', store_type: 'online', district: null, municipality: null, parish: null };
  onlineRows = [online];
  resolvePage = () => [];
  try {
    for (const selection of [null, { district: 'Faro' }, { district: 'Lisboa', municipality: 'Lisboa' }]) {
      calls.length = 0;
      assert.deepEqual(await getStores(selection), [online]);
      const onlineQueryStart = calls.findLastIndex(([method]) => method === 'from');
      assert.ok(calls.slice(onlineQueryStart).every(([method]) => method !== 'ilike'));
      assert.ok(calls.slice(onlineQueryStart).some(([method, field, value]) => method === 'eq' && field === 'source_type' && value === 'continente'));
    }
    onlineRows = [online, { ...online, id: 'duplicate' }];
    await assert.rejects(getStores(null), /mais de uma/);
  } finally { onlineRows = []; }
});