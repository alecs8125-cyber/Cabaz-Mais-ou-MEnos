import { supabase } from '../lib/supabase';
import { isContinenteOnline } from '../lib/store-channel';

export interface StoreLocationFilter {
  readonly district?: string | null;
  readonly municipality?: string | null;
  readonly parish?: string | null;
}

const STORE_COLUMNS = 'id,name,active,district,municipality,parish,source_type,external_id,store_type';
const STORE_PAGE_SIZE = 500;
const ACCENTABLE_LATIN_BASES = new Set(['a', 'c', 'e', 'i', 'n', 'o', 'u', 'y']);

function accentTolerantPattern(value: string): string {
  const characters = Array.from(value.normalize('NFD'));
  let pattern = '';

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (/[\u0300-\u036f]/.test(character)) continue;

    let hasCombiningMark = false;
    while (
      index + 1 < characters.length &&
      /[\u0300-\u036f]/.test(characters[index + 1])
    ) {
      index += 1;
      hasCombiningMark = true;
    }

    const base = character.toLocaleLowerCase('pt-PT');
    if (hasCombiningMark || ACCENTABLE_LATIN_BASES.has(base)) {
      // ILIKE is case-insensitive; wildcards let the server return common
      // accented/unaccented variants. The exact normalized match is checked
      // defensively by filterActiveStoresForLocation after retrieval.
      pattern += '%';
    } else {
      pattern += character.replace(/[\\%_]/g, '\\$&');
    }
  }

  return pattern;
}

// Physical stores remain area-scoped. Continente Online is fetched separately.
export async function getStores(
  selection: StoreLocationFilter | null = null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  try {
    const district = selection?.district?.trim() || null;
    const municipality = selection?.municipality?.trim() || null;
    const parish = selection?.parish?.trim() || null;

    const stores: Record<string, unknown>[] = [];
    for (let offset = 0; district || municipality || parish; offset += STORE_PAGE_SIZE) {
      let request = supabase
        .schema('public')
        .from('stores')
        .select(STORE_COLUMNS)
        .eq('active', true);

      if (district) request = request.ilike('district', accentTolerantPattern(district));
      if (municipality) {
        request = request.ilike('municipality', accentTolerantPattern(municipality));
      }
      if (parish) request = request.ilike('parish', accentTolerantPattern(parish));

      request = request
        .order('id', { ascending: true })
        .range(offset, offset + STORE_PAGE_SIZE - 1);
      if (signal) request = request.abortSignal(signal);

      const { data, error } = await request;
      if (error) {
        throw new Error(
          error.code ? `[${error.code}] ${error.message}` : error.message,
        );
      }
      if (!Array.isArray(data)) {
        throw new Error('O Supabase devolveu uma resposta inválida.');
      }

      stores.push(...data);
      if (data.length < STORE_PAGE_SIZE) break;
    }

    let onlineRequest = supabase.schema('public').from('stores')
      .select(STORE_COLUMNS)
      .eq('active', true)
      .eq('source_type', 'continente')
      .eq('external_id', 'online')
      .range(0, 1);
    if (signal) onlineRequest = onlineRequest.abortSignal(signal);
    const { data: online, error: onlineError } = await onlineRequest;
    if (onlineError) throw new Error(onlineError.code ? `[${onlineError.code}] ${onlineError.message}` : onlineError.message);
    if (!Array.isArray(online) || online.some((row) => !isContinenteOnline(row))) {
      throw new Error('Resposta inválida para Continente Online.');
    }
    if (online.length > 1) throw new Error('Existe mais de uma loja Continente Online.');
    const distinct = new Map(stores.filter((row) => !isContinenteOnline(row)).map((row) => [row.id, row]));
    for (const row of online) distinct.set(row.id, row);
    return [...distinct.values()];
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(
      `Não foi possível carregar as lojas de public.stores: ${message}`,
      { cause },
    );
  }
}