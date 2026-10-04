import { supabase } from '../lib/supabase';
import type { ProductGroup, ProductGroupMember } from '../lib/product-types';

const PRODUCT_GROUP_COLUMNS =
  'id,name,product_type,variant,package_quantity,package_unit';
const PRODUCT_GROUP_MEMBER_COLUMNS = 'id,name,brand,barcode,unit';

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

function readProductGroup(row: Record<string, unknown>): ProductGroup {
  if (
    !row || typeof row !== 'object' ||
    typeof row.id !== 'string' || !row.id.trim() ||
    typeof row.name !== 'string' || !row.name.trim() ||
    typeof row.product_type !== 'string' || !row.product_type.trim() ||
    typeof row.variant !== 'string' || !row.variant.trim() ||
    typeof row.package_quantity !== 'number' ||
    !Number.isFinite(row.package_quantity) || row.package_quantity <= 0 ||
    typeof row.package_unit !== 'string' || !row.package_unit.trim()
  ) {
    throw new Error('O Supabase devolveu um grupo de produtos inválido.');
  }

  return {
    id: row.id,
    name: row.name,
    productType: row.product_type,
    variant: row.variant,
    packageQuantity: row.package_quantity,
    packageUnit: row.package_unit,
  };
}

function readProductGroupMember(row: Record<string, unknown>): ProductGroupMember {
  if (
    !row || typeof row !== 'object' ||
    typeof row.id !== 'string' || !row.id.trim() ||
    typeof row.name !== 'string' || !row.name.trim() ||
    !['brand', 'barcode', 'unit'].every(
      (field) => row[field] === null || typeof row[field] === 'string',
    )
  ) {
    throw new Error('O Supabase devolveu um produto do grupo inválido.');
  }

  return {
    id: row.id,
    name: row.name,
    brand: row.brand as string | null,
    barcode: row.barcode as string | null,
    unit: row.unit as string | null,
  };
}

export async function getProductGroups(signal?: AbortSignal): Promise<ProductGroup[]> {
  try {
    return await withRequestSignal(async (requestSignal) => {
      const { data, error } = await supabase
        .schema('public')
        .from('product_groups')
        .select(PRODUCT_GROUP_COLUMNS)
        .eq('active', true)
        .order('product_type', { ascending: true })
        .order('variant', { ascending: true })
        .order('package_quantity', { ascending: true })
        .order('package_unit', { ascending: true })
        .order('id', { ascending: true })
        .retry(false)
        .abortSignal(requestSignal);

      if (error) {
        throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
      }
      if (!Array.isArray(data)) {
        throw new Error('O Supabase devolveu uma lista de grupos inválida.');
      }

      return data.map(readProductGroup);
    }, signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(
      `Não foi possível carregar os grupos de public.product_groups: ${message}`,
      { cause },
    );
  }
}

export async function getProductGroupMembers(
  groupId: string,
  signal?: AbortSignal,
): Promise<ProductGroupMember[]> {
  try {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) throw new Error('O grupo selecionado é inválido.');

    return await withRequestSignal(async (requestSignal) => {
      const { data: links, error: linksError } = await supabase
        .schema('public')
        .from('product_group_items')
        .select('product_id')
        .eq('group_id', normalizedGroupId)
        .order('product_id', { ascending: true })
        .retry(false)
        .abortSignal(requestSignal);

      if (linksError) {
        throw new Error(
          linksError.code ? `[${linksError.code}] ${linksError.message}` : linksError.message,
        );
      }
      if (!Array.isArray(links)) {
        throw new Error('O Supabase devolveu uma lista de membros inválida.');
      }

      const productIds = [...new Set(links.map((link: Record<string, unknown>) => {
        if (!link || typeof link.product_id !== 'string' || !link.product_id.trim()) {
          throw new Error('O Supabase devolveu um ID de produto inválido no grupo.');
        }
        return link.product_id;
      }))];
      if (productIds.length === 0) return [];

      const { data, error } = await supabase
        .schema('public')
        .from('products')
        .select(PRODUCT_GROUP_MEMBER_COLUMNS)
        .in('id', productIds)
        .eq('active', true)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .retry(false)
        .abortSignal(requestSignal);

      if (error) {
        throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
      }
      if (!Array.isArray(data)) {
        throw new Error('O Supabase devolveu uma lista de produtos do grupo inválida.');
      }

      return data.map(readProductGroupMember);
    }, signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(
      `Não foi possível carregar os membros do grupo em public.product_group_items: ${message}`,
      { cause },
    );
  }
}