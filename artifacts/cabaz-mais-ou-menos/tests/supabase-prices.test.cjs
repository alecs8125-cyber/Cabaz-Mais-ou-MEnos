const test = require('node:test');
const assert = require('node:assert/strict');
const storeRows = [
  { id: 'a', name: 'Supermercado Demo A', active: true, district: 'Faro', municipality: 'Loulé', parish: 'Quarteira' },
  { id: 'b', name: 'Supermercado Demo B', active: true, district: 'Faro', municipality: 'Loulé', parish: 'Loulé' },
  { id: 'c', name: 'Minimercado Demo C', active: true, district: 'Faro', municipality: 'Albufeira', parish: 'Albufeira' },
  { id: 'd', name: 'Mercado Demo D', active: true, district: 'Faro', municipality: 'Faro', parish: 'Faro' },
  { id: 'e', name: 'Mercearia Demo E', active: true, district: 'Faro', municipality: 'Loulé', parish: 'Quarteira' },
  { id: 'other', name: 'Loja de teste fora do distrito', active: true, district: 'Lisboa', municipality: 'Lisboa', parish: 'Lisboa' },
  { id: 'inactive', name: 'Loja inativa', active: false, district: 'Faro', municipality: 'Loulé', parish: 'Quarteira' },
];

const calls = [];
let responseRows = [];
const request = {
  then(resolve, reject) {
    return Promise.resolve({ data: responseRows, error: null }).then(resolve, reject);
  },
};
for (const method of ['select', 'in', 'eq', 'lte', 'or', 'order', 'range', 'retry', 'abortSignal']) {
  request[method] = (...args) => {
    calls.push([method, ...args]);
    return request;
  };
}
const supabase = {
  schema(name) {
    calls.push(['schema', name]);
    return {
      from(table) {
        calls.push(['from', table]);
        return request;
      },
    };
  },
};
const supabasePath = require.resolve('../.test-build/lib/supabase.js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: { supabase },
};
const storesPath = require.resolve('../.test-build/services/stores.js');
require.cache[storesPath] = {
  id: storesPath, filename: storesPath, loaded: true,
  exports: { getStores: async () => storeRows },
};
const { filterActiveStoresForLocation, getComparisonData } = require('../.test-build/services/prices.js');

test('online ignora zona, não recebe distância/localidade e uma loja física Continente não ignora zona', async () => {
  const online = { id: 'online', name: 'Continente Online', active: true, source_type: 'continente', external_id: 'online', district: null, municipality: null, parish: null };
  const physical = { ...online, id: 'physical', external_id: 'store-1', district: 'Lisboa' };
  assert.deepEqual(filterActiveStoresForLocation([online, physical, { ...online, active: false }], { district: 'Faro' }), [online]);
  storeRows.push(online, physical);
  try {
    responseRows = [{
      id: 'p-online', product_id: 'milk', store_id: 'online', price: '2.09', currency: 'EUR',
      verification_status: 'verified', source_type: 'continente',
      captured_at: new Date(Date.now() - 1000).toISOString(), valid_from: null, valid_until: new Date(Date.now() + 10000).toISOString(),
    }];
    const result = await getComparisonData(['milk'], { district: 'Faro' });
    const channel = result.stores.find((s) => s.id === 'online');
    assert.deepEqual(channel, { id: 'online', name: 'Continente Online', isOnline: true });
    for (const key of ['distance', 'distanceKm', 'district', 'municipality', 'parish']) assert.equal(key in channel, false);
    assert.equal(result.stores.some((s) => s.id === 'physical'), false);
    assert.equal(result.prices[0].storeId, 'online');
  } finally { storeRows.splice(-2); }
});

function row(price, capturedAt, validFrom = null, validUntil = null, verificationStatus = 'verified') {
  return {
    id: 'price-1',
    product_id: 'milk',
    store_id: 'a',
    price,
    currency: 'EUR',
    captured_at: capturedAt,
    valid_from: validFrom,
    valid_until: validUntil,
    source_type: 'demo',
    verification_status: verificationStatus,
  };
}

test('a consulta só pede preços verified, já capturados e em vigor, nas lojas ativas', async () => {
  calls.length = 0;
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  responseRows = [
    row('1.23', yesterday),
    row('9.99', yesterday, tomorrow),
    row('9.99', tomorrow),
  ];
  const result = await getComparisonData(['milk']);
  assert.deepEqual(result.stores.map(({ id }) => id).sort(), ['a', 'b', 'c', 'd', 'e', 'other']);
  assert.equal(result.prices.length, 1);
  assert.equal(result.prices[0].priceCents, 123);
  assert.ok(calls.some(([method, field, value]) =>
    method === 'eq' && field === 'verification_status' && value === 'verified'));
  assert.ok(calls.some(([method, field]) => method === 'lte' && field === 'captured_at'));
  assert.ok(calls.some(([method, condition]) =>
    method === 'or' && condition.startsWith('valid_from.is.null,valid_from.lte.')));
  assert.ok(calls.some(([method, condition]) =>
    method === 'or' && condition.startsWith('valid_until.is.null,valid_until.gte.')));
  assert.ok(calls.some(([method, columns]) =>
    method === 'select' && columns.includes('valid_until')));
  assert.ok(calls.some(([method, field, ids]) =>
    method === 'in' && field === 'store_id' && ids.length === 6 && !ids.includes('inactive')));
  assert.ok(calls.some(([method, field, options]) =>
    method === 'order' && field === 'captured_at' && options.ascending === false));
});

test('valid_until null, futuro e exatamente agora continuam elegíveis', async () => {
  const fixedNow = Date.parse('2026-09-30T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const capturedAt = new Date(fixedNow - 60000).toISOString();
    const validUntilValues = [
      null,
      new Date(fixedNow + 60000).toISOString(),
      new Date(fixedNow).toISOString(),
    ];
    for (const validUntil of validUntilValues) {
      responseRows = [row('1.23', capturedAt, null, validUntil)];
      const result = await getComparisonData(['milk']);
      assert.equal(result.prices.length, 1);
      assert.equal(result.prices[0].priceCents, 123);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('valid_until passado é ignorado e uma data inválida é rejeitada', async () => {
  const fixedNow = Date.parse('2026-09-30T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const capturedAt = new Date(fixedNow - 60000).toISOString();
    responseRows = [row('1.23', capturedAt, null, new Date(fixedNow - 1).toISOString())];
    const expired = await getComparisonData(['milk']);
    assert.equal(expired.prices.length, 0);

    responseRows = [row('1.23', capturedAt, null, 'invalid-date')];
    await assert.rejects(() => getComparisonData(['milk']), /data de preço inválida/);
  } finally {
    Date.now = originalNow;
  }
});

test('pending, rejected e expired nunca são aceites como preços verificados', async () => {
  const capturedAt = new Date(Date.now() - 60000).toISOString();
  for (const status of ['pending', 'rejected', 'expired']) {
    responseRows = [row('1.23', capturedAt, null, null, status)];
    await assert.rejects(() => getComparisonData(['milk']), /campos inválidos/);
  }
});

test('um preço verified dentro do intervalo temporal é usado', async () => {
  const fixedNow = Date.parse('2026-09-30T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    responseRows = [row(
      '1.23',
      new Date(fixedNow - 60000).toISOString(),
      new Date(fixedNow - 30000).toISOString(),
      new Date(fixedNow + 30000).toISOString(),
    )];
    const result = await getComparisonData(['milk']);
    assert.equal(result.prices.length, 1);
    assert.equal(result.prices[0].priceCents, 123);
  } finally {
    Date.now = originalNow;
  }
});

test('seleciona o registo mais recente entre preços temporalmente elegíveis', async () => {
  const fixedNow = Date.parse('2026-09-30T12:00:00.000Z');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const capturedAt = (offset) => new Date(fixedNow - offset).toISOString();
    responseRows = [
      row('9.99', capturedAt(60000), null, new Date(fixedNow - 1).toISOString()),
      row('2.50', capturedAt(120000), capturedAt(180000), new Date(fixedNow + 60000).toISOString()),
      row('1.50', capturedAt(180000)),
    ];
    const result = await getComparisonData(['milk']);
    assert.equal(result.prices.length, 1);
    assert.equal(result.prices[0].priceCents, 250);
    assert.equal(result.prices[0].capturedAt, capturedAt(120000));
  } finally {
    Date.now = originalNow;
  }
});

test('o filtro de localização é progressivo e exclui sempre as lojas inativas', () => {
  const districtOnly = filterActiveStoresForLocation(storeRows, { district: 'Faro' });
  assert.deepEqual(districtOnly.map(({ id }) => id).sort(), ['a', 'b', 'c', 'd', 'e']);

  const municipality = filterActiveStoresForLocation(storeRows, {
    district: 'Faro',
    municipality: 'Loulé',
  });
  assert.deepEqual(municipality.map(({ id }) => id).sort(), ['a', 'b', 'e']);

  const parish = filterActiveStoresForLocation(storeRows, {
    district: 'Faro',
    municipality: 'Loulé',
    parish: 'Quarteira',
  });
  assert.deepEqual(parish.map(({ id }) => id).sort(), ['a', 'e']);
});

test('a validação local mantém a correspondência com diferenças de maiúsculas e acentos', () => {
  const variants = [{
    id: 'variant',
    active: true,
    district: 'FARO',
    municipality: 'LOULE',
    parish: 'QUARTEIRA',
  }];
  const result = filterActiveStoresForLocation(variants, {
    district: 'Faro',
    municipality: 'Loulé',
    parish: 'Quarteira',
  });
  assert.deepEqual(result.map(({ id }) => id), ['variant']);
});

test('a referência Auchan aparece apenas em Lisboa/Amadora, sem distância e com nota de âmbito', async () => {
  const reference = {
    id: 'auchan-reference',
    name: 'Nome interno do registo',
    active: true,
    district: 'Lisboa',
    municipality: 'Amadora',
    parish: null,
    source_type: 'auchan',
    external_id: 'reference:2650-435',
    store_type: 'online_reference',
    postal_code: '2650-435',
  };
  storeRows.push(reference);
  try {
    assert.deepEqual(
      filterActiveStoresForLocation([reference], { district: 'Lisboa' }),
      [],
    );
    assert.deepEqual(
      filterActiveStoresForLocation([reference], { district: 'Faro', municipality: 'Loulé' }),
      [],
    );
    assert.deepEqual(
      filterActiveStoresForLocation([reference], { district: 'Lisboa', municipality: 'Amadora' }),
      [reference],
    );

    responseRows = [{
      ...row('2.35', new Date(Date.now() - 60000).toISOString()),
      store_id: reference.id,
      source_type: 'auchan',
    }];
    const result = await getComparisonData(['milk'], {
      district: 'Lisboa',
      municipality: 'Amadora',
    });
    const channel = result.stores.find((store) => store.id === reference.id);
    assert.deepEqual(channel, {
      id: reference.id,
      name: 'Auchan Online · referência 2650-435 (Amadora)',
      isOnline: true,
      isRegionalReference: true,
      referenceScopeNote: 'Preço de referência para entregas e recolhas no código postal 2650-435 (Amadora). Pode não corresponder ao preço aplicável ao teu código postal nem a uma loja física.',
    });
    assert.equal(result.prices[0].storeId, reference.id);
    for (const key of ['distance', 'distanceKm', 'district', 'municipality', 'parish']) {
      assert.equal(key in channel, false);
    }

    const faro = await getComparisonData(['milk'], { district: 'Faro', municipality: 'Loulé' });
    assert.equal(faro.stores.some((store) => store.id === reference.id), false);
  } finally {
    storeRows.pop();
  }
});

test('a consulta de comparação usa apenas lojas da freguesia escolhida', async () => {
  calls.length = 0;
  responseRows = [row('1.23', new Date(Date.now() - 60000).toISOString())];
  const result = await getComparisonData(['milk'], {
    district: 'Faro',
    municipality: 'Loulé',
    parish: 'Quarteira',
  });
  assert.deepEqual(result.stores.map(({ id }) => id), ['e', 'a']);
  assert.ok(calls.some(([method, field, ids]) =>
    method === 'in' && field === 'store_id' && ids.length === 2 && ids.includes('a') && ids.includes('e')));
});

test('productIds deduplicados são consultados em lotes de 50, não numa consulta por SKU', async () => {
  calls.length = 0;
  responseRows = [];
  const ids = Array.from({ length: 51 }, (_, index) => `candidate-${index}`);
  ids.push('candidate-0');

  const result = await getComparisonData(ids);
  const batches = calls
    .filter(([method, field]) => method === 'in' && field === 'product_id')
    .map(([, , batch]) => batch);

  assert.equal(result.prices.length, 0);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 1]);
  assert.equal(new Set(batches.flat()).size, 51);
});

test('converte valores decimais grandes sem perder um cêntimo', async () => {
  responseRows = [row('86876369320553.10', new Date(Date.now() - 60000).toISOString())];
  const result = await getComparisonData(['milk']);
  assert.equal(result.prices[0].priceCents, 8687636932055310);
});

test('rejeita montantes que não cabem em cêntimos inteiros seguros', async () => {
  responseRows = [row('90071992547409.92', new Date(Date.now() - 60000).toISOString())];
  await assert.rejects(() => getComparisonData(['milk']), /valor positivo em euros/);
});