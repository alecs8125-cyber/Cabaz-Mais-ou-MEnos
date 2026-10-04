import { supabase } from '../lib/supabase';

const PAGE_SIZE = 200;
const HISTORY_COLUMNS = 'price,captured_at,stores(name)';

export interface ProductPriceHistoryEntry {
  readonly storeName: string;
  readonly priceCents: number;
  readonly capturedAt: string;
}

function readHistoryEntry(row: Record<string, unknown>): ProductPriceHistoryEntry {
  const relation = Array.isArray(row.stores) ? row.stores[0] : row.stores;
  const storeName = relation && typeof relation === 'object'
    ? (relation as Record<string, unknown>).name
    : null;
  if (
    typeof storeName !== 'string' || !storeName.trim() ||
    typeof row.captured_at !== 'string' ||
    !Number.isFinite(Date.parse(row.captured_at))
  ) {
    throw new Error('O Supabase devolveu um registo de histórico inválido.');
  }

  const amount = typeof row.price === 'number' || typeof row.price === 'string'
    ? String(row.price) : '';
  const decimal = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!decimal) {
    throw new Error('O preço histórico não pode ser convertido com segurança para cêntimos.');
  }
  const euros = Number(decimal[1]);
  const cents = Number((decimal[2] ?? '').padEnd(2, '0'));
  const priceCents = euros * 100 + cents;
  if (!Number.isSafeInteger(priceCents)) {
    throw new Error('O preço histórico ultrapassa o limite de cêntimos seguros.');
  }

  return {
    storeName: storeName.trim(),
    priceCents,
    capturedAt: row.captured_at,
  };
}

/** Lê o histórico existente do produto, mais recente primeiro, sem gerar registos. */
export async function getProductPriceHistory(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductPriceHistoryEntry[]> {
  try {
    if (!productId.trim()) throw new Error('O identificador do produto é inválido.');

    const entries: ProductPriceHistoryEntry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let request = supabase
        .schema('public')
        .from('price_history')
        .select(HISTORY_COLUMNS)
        .eq('product_id', productId)
        .order('captured_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)
        .retry(false);
      if (signal) request = request.abortSignal(signal);

      const { data, error } = await request;
      if (error) {
        throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
      }
      if (!Array.isArray(data)) {
        throw new Error('O Supabase devolveu uma resposta de histórico inválida.');
      }
      entries.push(...data.map(readHistoryEntry));
      if (data.length < PAGE_SIZE) break;
    }
    return entries;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(`Não foi possível carregar public.price_history: ${message}`, { cause });
  }
}