import { supabase } from '../lib/supabase';
import type { SupabaseProduct } from '../lib/product-types';

export const PRODUCT_PAGE_SIZE = 20;
const PRODUCT_COLUMNS = 'id,name,brand,barcode,category,unit,active';
const CATEGORY_PAGE_SIZE = 100;

export interface ProductSearchOptions {
  query?: string;
  category?: string | null;
  offset?: number;
  signal?: AbortSignal;
}

export interface ProductPage {
  products: SupabaseProduct[];
  nextOffset: number | null;
}

function readProduct(row: Record<string, unknown>): SupabaseProduct {
  if (
    !row || typeof row !== 'object' ||
    typeof row.id !== 'string' || !row.id.trim() ||
    typeof row.name !== 'string' || !row.name.trim() ||
    row.active !== true ||
    !['brand', 'category', 'unit'].every(
      (field) => row[field] === null || typeof row[field] === 'string',
    ) ||
    (row.barcode !== null && typeof row.barcode !== 'string')
  ) {
    throw new Error('O Supabase devolveu um produto com campos inválidos.');
  }

  return {
    id: row.id,
    name: row.name,
    brand: row.brand as string | null,
    barcode: row.barcode as string | null,
    category: row.category as string | null,
    unit: row.unit as string | null,
    active: true,
    isDemo: false,
    // public.products não contém preços. Nunca substituir por preços fictícios.
    demoPriceCents: null,
  };
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function withRequestSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener('abort', abort);
  const timeout = setTimeout(abort, 15000);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}

export async function getProducts({
  query = '',
  category = null,
  offset = 0,
  signal,
}: ProductSearchOptions = {}): Promise<ProductPage> {
  try {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Página de produtos inválida.');
    }

    return await withRequestSignal(async (requestSignal) => {
      let request = supabase
        .schema('public')
        .from('products')
        .select(PRODUCT_COLUMNS, { count: 'exact' })
        .eq('active', true)
        .order('name', { ascending: true })
        .order('id', { ascending: true });

      const name = query.trim().replace(/\s+/g, ' ');
      if (name) {
        // Escapar LIKE e citar valores para que a sintaxe do filtro OR não os interprete como operadores.
        const escapedName = name.replace(/[\\%_]/g, '\\$&');
        const namePattern = quotePostgrestValue(`%${escapedName}%`);
        request = request.or(
          `name.ilike.${namePattern},brand.ilike.${namePattern},barcode.eq.${quotePostgrestValue(name)}`,
        );
      }
      if (category !== null) request = request.eq('category', category);

      const { data, error, count } = await request
        .range(offset, offset + PRODUCT_PAGE_SIZE - 1)
        .retry(false)
        .abortSignal(requestSignal);
      if (error) {
        throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
      }
      if (!Array.isArray(data)) {
        throw new Error('O Supabase devolveu uma resposta inválida.');
      }
      if (count === null || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('O Supabase devolveu uma contagem de produtos inválida.');
      }

      return {
        products: data.map(readProduct),
        nextOffset: data.length > 0 && offset + data.length < count ? offset + data.length : null,
      };
    }, signal);
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(
      `Não foi possível carregar os produtos de public.products: ${message}`,
      { cause },
    );
  }
}

export async function getProductCategories(signal?: AbortSignal): Promise<string[]> {
  try {
    return await withRequestSignal(async (requestSignal) => {
      const categories = new Set<string>();
      let after: string | undefined;
      while (true) {
        let request = supabase
          .schema('public')
          .from('products')
          .select('category')
          .eq('active', true)
          .not('category', 'is', null)
          .order('category', { ascending: true })
          .limit(CATEGORY_PAGE_SIZE);
        if (after !== undefined) request = request.gt('category', after);

        const { data, error } = await request.retry(false).abortSignal(requestSignal);
        if (error) {
          throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
        }
        if (!Array.isArray(data) || data.some((row) => typeof row.category !== 'string')) {
          throw new Error('O Supabase devolveu categorias inválidas.');
        }
        for (const row of data) {
          if (row.category.trim()) categories.add(row.category);
        }
        if (data.length < CATEGORY_PAGE_SIZE) break;
        // Saltar as repetições da última categoria; não carregar todos os produtos.
        after = data[data.length - 1].category;
      }
      return [...categories].sort((a, b) => a.localeCompare(b, 'pt-PT'));
    }, signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(`Não foi possível carregar as categorias de public.products: ${message}`, { cause });
  }
}