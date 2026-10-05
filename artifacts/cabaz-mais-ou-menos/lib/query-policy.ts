const MAX_READ_RETRIES = 2;
const NETWORK_FAILURE =
  /\b(fetch failed|failed to fetch|network request failed|networkerror|err_network|econnreset|econnrefused|etimedout|eai_again|enotfound|ehostunreach|enetunreach|connection reset|connection refused|timed out|timeout)\b/i;

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  while (current !== null && current !== undefined && chain.length < 8) {
    chain.push(current);
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isExplicitlyTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const status = [record.status, record.statusCode]
    .find((value): value is number => typeof value === 'number');
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }
  const code = typeof record.code === 'string' ? record.code : '';
  if (/^(429|5\d\d)$/.test(code)) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return NETWORK_FAILURE.test(`${code} ${message}`);
}

export function shouldRetryReadQuery(failureCount: number, error: unknown): boolean {
  if (!Number.isSafeInteger(failureCount) || failureCount >= MAX_READ_RETRIES) return false;
  const chain = errorChain(error);
  if (chain.some((entry) =>
    typeof entry === 'object' && entry !== null &&
    (entry as { name?: unknown }).name === 'AbortError',
  )) {
    return false;
  }
  return chain.some(isExplicitlyTransient);
}

export function readQueryRetryDelay(attemptIndex: number): number {
  return Math.min(750 * 2 ** Math.max(0, attemptIndex), 4000);
}

function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const error = signal?.reason instanceof Error
        ? signal.reason
        : new Error('A atualização do catálogo foi cancelada.');
      if (!(signal?.reason instanceof Error)) error.name = 'AbortError';
      reject(error);
    };
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function retryReadOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let failureCount = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!shouldRetryReadQuery(failureCount, error)) throw error;
      await waitBeforeRetry(readQueryRetryDelay(failureCount), signal);
      failureCount += 1;
    }
  }
}
