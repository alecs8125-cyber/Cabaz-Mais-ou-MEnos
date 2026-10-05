const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readQueryRetryDelay,
  retryReadOperation,
  shouldRetryReadQuery,
} = require('../.test-build/lib/query-policy.js');

test('read queries retry bounded temporary network and server failures', () => {
  const networkError = new Error('Não foi possível carregar os produtos.', {
    cause: new TypeError('fetch failed'),
  });
  const unavailable = { code: '503', message: 'Service unavailable' };

  assert.equal(shouldRetryReadQuery(0, networkError), true);
  assert.equal(shouldRetryReadQuery(1, networkError), true);
  assert.equal(shouldRetryReadQuery(2, networkError), false);
  assert.equal(shouldRetryReadQuery(0, unavailable), true);
  assert.equal(shouldRetryReadQuery(0, { status: 429 }), true);
  assert.deepEqual([0, 1, 2, 8].map(readQueryRetryDelay), [750, 1500, 3000, 4000]);
});

test('read queries do not retry malformed, permission, client, or cancelled requests', () => {
  assert.equal(shouldRetryReadQuery(0, new Error('O catálogo devolveu campos inválidos.')), false);
  assert.equal(
    shouldRetryReadQuery(0, { code: '42501', message: 'permission denied' }),
    false,
  );
  assert.equal(shouldRetryReadQuery(0, { status: 404, message: 'not found' }), false);
  assert.equal(
    shouldRetryReadQuery(0, {
      name: 'AbortError',
      cause: new TypeError('fetch failed'),
    }),
    false,
  );
});

test('direct catalog reads retry transient failures and stop waiting when cancelled', async () => {
  let attempts = 0;
  const result = await retryReadOperation(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return ['active-product'];
  });
  assert.deepEqual(result, ['active-product']);
  assert.equal(attempts, 2);

  const controller = new AbortController();
  let cancelledAttempts = 0;
  const pending = retryReadOperation(async () => {
    cancelledAttempts += 1;
    throw new TypeError('fetch failed');
  }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelledAttempts, 1);
});
