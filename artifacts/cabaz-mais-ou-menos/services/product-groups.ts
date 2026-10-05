import { supabase } from '../lib/supabase';
import { normalizeProductGroupBrand } from '../lib/product-group-options';
import type {
  ProductGroup,
  ProductGroupBrandLabel,
  ProductGroupCatalogMetadata,
  ProductGroupMember,
} from '../lib/product-types';

const PRODUCT_GROUP_COLUMNS =
  'id,name,product_type,variant,package_quantity,package_unit';
const PRODUCT_GROUP_MEMBER_COLUMNS = 'id,name,brand,barcode,unit';
const PRODUCT_GROUP_BRAND_COLUMNS = 'id,name,brand';
const PRODUCT_GROUP_LINK_PAGE_SIZE = 1000;
const ID_QUERY_BATCH_SIZE = 100;

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

export async function getProductGroupCatalogMetadata(
  groupIds: readonly string[],
  signal?: AbortSignal,
): Promise<ProductGroupCatalogMetadata> {
  const uniqueGroupIds = [...new Set(groupIds)];
  if (uniqueGroupIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('A lista de grupos para recuperar marcas é inválida.');
  }
  if (uniqueGroupIds.length === 0) {
    return { availableGroupIds: [], brandLabels: [] };
  }

  try {
    return await withRequestSignal(async (requestSignal) => {
      const requestedGroupIds = new Set(uniqueGroupIds);
      const productIdsByGroup = new Map(
        uniqueGroupIds.map((groupId) => [groupId, new Set<string>()]),
      );

      for (let offset = 0; offset < uniqueGroupIds.length; offset += ID_QUERY_BATCH_SIZE) {
        const groupBatch = uniqueGroupIds.slice(offset, offset + ID_QUERY_BATCH_SIZE);
        let pageOffset = 0;
        while (true) {
          const { data, error } = await supabase
            .schema('public')
            .from('product_group_items')
            .select('group_id,product_id')
            .in('group_id', groupBatch)
            .order('group_id', { ascending: true })
            .order('product_id', { ascending: true })
            .range(pageOffset, pageOffset + PRODUCT_GROUP_LINK_PAGE_SIZE - 1)
            .retry(false)
            .abortSignal(requestSignal);

          if (error) {
            throw new Error(
              error.code ? `[${error.code}] ${error.message}` : error.message,
            );
          }
          if (!Array.isArray(data)) {
            throw new Error('O Supabase devolveu relações de grupos inválidas.');
          }
          for (const row of data as Record<string, unknown>[]) {
            if (
              !row || typeof row.group_id !== 'string' ||
              !requestedGroupIds.has(row.group_id) ||
              typeof row.product_id !== 'string' || !row.product_id.trim()
            ) {
              throw new Error('O Supabase devolveu uma relação de grupo inválida.');
            }
            productIdsByGroup.get(row.group_id)!.add(row.product_id);
          }
          if (data.length < PRODUCT_GROUP_LINK_PAGE_SIZE) break;
          pageOffset += data.length;
        }
      }

      const groupIdsByProduct = new Map<string, Set<string>>();
      for (const [groupId, productIds] of productIdsByGroup) {
        for (const productId of productIds) {
          const groups = groupIdsByProduct.get(productId) ?? new Set<string>();
          groups.add(groupId);
          groupIdsByProduct.set(productId, groups);
        }
      }

      const productIds = [...groupIdsByProduct.keys()].sort();
      if (productIds.length === 0) {
        return { availableGroupIds: [], brandLabels: [] };
      }
      const requestedProductIds = new Set(productIds);
      const products: { id: string; name: string; brand: string | null }[] = [];

      for (let offset = 0; offset < productIds.length; offset += ID_QUERY_BATCH_SIZE) {
        const productBatch = productIds.slice(offset, offset + ID_QUERY_BATCH_SIZE);
        const { data, error } = await supabase
          .schema('public')
          .from('products')
          .select(PRODUCT_GROUP_BRAND_COLUMNS)
          .in('id', productBatch)
          .eq('active', true)
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .retry(false)
          .abortSignal(requestSignal);

        if (error) {
          throw new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
        }
        if (!Array.isArray(data)) {
          throw new Error('O Supabase devolveu marcas de produtos inválidas.');
        }
        for (const row of data as Record<string, unknown>[]) {
          if (
            !row || typeof row.id !== 'string' ||
            !requestedProductIds.has(row.id) ||
            typeof row.name !== 'string' || !row.name.trim() ||
            !(row.brand === null || typeof row.brand === 'string')
          ) {
            throw new Error('O Supabase devolveu um produto de marca inválido.');
          }
          products.push({
            id: row.id,
            name: row.name,
            brand: row.brand as string | null,
          });
        }
      }

      products.sort((a, b) =>
        a.name.localeCompare(b.name, 'pt-PT') || a.id.localeCompare(b.id),
      );
      const availableGroupIds = new Set<string>();
      const labelsByIdentity = new Map<
        string,
        { groupId: string; brand: string; labels: Map<string, number> }
      >();
      for (const product of products) {
        const productGroupIds = groupIdsByProduct.get(product.id) ?? [];
        for (const groupId of productGroupIds) availableGroupIds.add(groupId);

        const label = product.brand?.trim();
        const brand = normalizeProductGroupBrand(label);
        if (!brand || !label) continue;

        for (const groupId of productGroupIds) {
          const identity = JSON.stringify([groupId, brand]);
          const entry = labelsByIdentity.get(identity) ?? {
            groupId,
            brand,
            labels: new Map<string, number>(),
          };
          entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
          labelsByIdentity.set(identity, entry);
        }
      }
      const brandLabels = [...labelsByIdentity.values()]
        .map(({ groupId, brand, labels }) => ({
          groupId,
          brand,
          label: [...labels.entries()].sort(([leftLabel, leftCount], [rightLabel, rightCount]) =>
            rightCount - leftCount ||
            (leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0),
          )[0][0],
        }))
        .sort((a, b) =>
          a.groupId.localeCompare(b.groupId) || a.brand.localeCompare(b.brand),
        );
      return {
        availableGroupIds: [...availableGroupIds].sort(),
        brandLabels,
      };
    }, signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Erro inesperado na ligação.';
    throw new Error(
      `Não foi possível carregar os nomes das marcas dos grupos: ${message}`,
      { cause },
    );
  }
}