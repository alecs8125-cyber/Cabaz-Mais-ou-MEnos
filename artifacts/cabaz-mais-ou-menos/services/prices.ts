import { supabase } from '../lib/supabase';
import { getStores, type StoreLocationFilter } from './stores';
import {
  AUCHAN_REFERENCE_SCOPE_NOTE,
  AUCHAN_REFERENCE_STORE_LABEL,
  isAuchanReferenceLocation,
  isAuchanRegionalReference,
  isContinenteOnline,
} from '../lib/store-channel';

const PAGE_SIZE = 200;
const PRODUCT_BATCH_SIZE = 50;
const STORE_BATCH_SIZE = 50;
const COLUMNS = 'id,product_id,store_id,price,currency,captured_at,valid_from,valid_until,source_type,verification_status';

export interface ComparisonStore {
  readonly id: string;
  readonly name: string;
  readonly isOnline?: boolean;
  readonly isRegionalReference?: boolean;
  readonly referenceScopeNote?: string;
}

export interface VerifiedPrice {
  readonly productId: string;
  readonly storeId: string;
  readonly priceCents: number;
  readonly capturedAt: string;
  readonly sourceType: string;
}

export interface ComparisonData {
  readonly stores: readonly ComparisonStore[];
  readonly prices: readonly VerifiedPrice[];
}

export type ComparisonLocationFilter = StoreLocationFilter;

export function filterActiveStoresForLocation(
  rows: readonly Record<string, unknown>[],
  selection: ComparisonLocationFilter | null,
): Record<string, unknown>[] {
  const district = selection?.district?.trim() || null;
  const municipality = selection?.municipality?.trim() || null;
  const parish = selection?.parish?.trim() || null;
  const normalize = (value: string) =>
    value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const matches = (value: unknown, expected: string | null) =>
    expected === null ||
    (typeof value === 'string' && normalize(value) === normalize(expected));

  return rows.filter((row) =>
    row.active === true &&
    (isContinenteOnline(row) ||
      (isAuchanRegionalReference(row)
        ? isAuchanReferenceLocation(selection)
        : matches(row.district, district) &&
          matches(row.municipality, municipality) &&
          matches(row.parish, parish))),
  );
}

function readStore(row: Record<string, unknown>): ComparisonStore {
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()) {
    throw new Error('O Supabase devolveu uma loja ativa com campos inválidos.');
  }
  if (isAuchanRegionalReference(row)) {
    return {
      id: row.id,
      name: AUCHAN_REFERENCE_STORE_LABEL,
      isOnline: true,
      isRegionalReference: true,
      referenceScopeNote: AUCHAN_REFERENCE_SCOPE_NOTE,
    };
  }
  return {
    id: row.id,
    name: isContinenteOnline(row) ? 'Continente Online' : row.name,
    ...(isContinenteOnline(row) ? { isOnline: true } : {}),
  };
}

function readPrice(row: Record<string, unknown>, now: number): VerifiedPrice | null {
  if (
    typeof row.product_id !== 'string' || !row.product_id ||
    typeof row.store_id !== 'string' || !row.store_id ||
    row.currency !== 'EUR' ||
    row.verification_status !== 'verified' ||
    typeof row.source_type !== 'string' ||
    typeof row.captured_at !== 'string'
  ) {
    throw new Error('O Supabase devolveu um preço verificado com campos inválidos.');
  }
  const captured = Date.parse(row.captured_at);
  const validFrom = row.valid_from === null ? null
    : typeof row.valid_from === 'string' ? Date.parse(row.valid_from) : NaN;
  const validUntil = row.valid_until === null ? null
    : typeof row.valid_until === 'string' ? Date.parse(row.valid_until) : NaN;
  if (
    !Number.isFinite(captured) ||
    (validFrom !== null && !Number.isFinite(validFrom)) ||
    (validUntil !== null && !Number.isFinite(validUntil))
  ) {
    throw new Error('O Supabase devolveu uma data de preço inválida.');
  }
  // Não usar preços capturados no futuro ou que ainda não entraram em vigor.
  // Um preço mantém-se válido até ao instante final, inclusive.
  if (
    captured > now ||
    (validFrom !== null && validFrom > now) ||
    (validUntil !== null && validUntil < now)
  ) return null;

  const amount = typeof row.price === 'number' || typeof row.price === 'string'
    ? String(row.price) : '';
  const decimal = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!decimal) {
    throw new Error('O preço não pode ser convertido com segurança para cêntimos.');
  }
  // Separar euros e cêntimos: multiplicar um valor decimal em ponto flutuante
  // por 100 pode perder um cêntimo mesmo quando o inteiro final é seguro.
  const euros = Number(decimal[1]);
  const cents = Number((decimal[2] ?? '').padEnd(2, '0'));
  const priceCents = euros * 100 + cents;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new Error('O preço tem de ser um valor positivo em euros.');
  }
  return {
    productId: row.product_id,
    storeId: row.store_id,
    priceCents,
    capturedAt: row.captured_at,
    sourceType: row.source_type,
  };
}

/** Ler apenas preços verificados, já em vigor, dos produtos e lojas relevantes. */
export async function getComparisonData(
  productIds: readonly string[],
  location: ComparisonLocationFilter | null = null,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ComparisonData> {
  try {
    const rawStores = filterActiveStoresForLocation(await getStores(location, signal), location);
    const stores = rawStores
      .map(readStore)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-PT'));
    const ids = [...new Set(productIds)];
    if (!ids.length || !stores.length) return { stores, prices: [] };

    const timestamp = new Date(now).toISOString();
    const latest = new Map<string, VerifiedPrice>();
    const storeIds = stores.map((store) => store.id);
    for (let start = 0; start < ids.length; start += PRODUCT_BATCH_SIZE) {
      const batch = ids.slice(start, start + PRODUCT_BATCH_SIZE);
      for (let storeStart = 0; storeStart < storeIds.length; storeStart += STORE_BATCH_SIZE) {
        const storeBatch = storeIds.slice(storeStart, storeStart + STORE_BATCH_SIZE);
        for (let offset = 0; ; offset += PAGE_SIZE) {
          let request = supabase.schema('public').from('prices')
            .select(COLUMNS)
            .in('product_id', batch)
            .in('store_id', storeBatch)
            .eq('verification_status', 'verified')
            .lte('captured_at', timestamp)
            .or(`valid_from.is.null,valid_from.lte.${timestamp}`)
            .or(`valid_until.is.null,valid_until.gte.${timestamp}`)
            .order('captured_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + PAGE_SIZE - 1)
            .retry(false);
          if (signal) request = request.abortSignal(signal);
          const { data, error } = await request;
          if (error) throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
          if (!Array.isArray(data)) throw new Error('O Supabase devolveu uma resposta inválida.');
          for (const row of data) {
            const price = readPrice(row, now);
            if (price) {
              const key = `${price.productId}:${price.storeId}`;
              if (!latest.has(key)) latest.set(key, price);
            }
          }
          if (data.length < PAGE_SIZE) break;
        }
      }
    }
    return { stores, prices: [...latest.values()] };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(`Não foi possível carregar os preços de public.prices: ${message}`, { cause });
  }
}