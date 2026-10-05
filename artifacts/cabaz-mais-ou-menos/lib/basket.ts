import type {
  CatalogProduct,
  ProductGroup,
  ProductGroupCatalogMetadata,
  SupabaseProduct,
} from './product-types';
import { getDemoProduct } from './products';

export interface ExactBasketLine {
  readonly kind?: 'exact';
  readonly productId: string;
  readonly quantity: number;
  readonly product?: SupabaseProduct;
}

export interface ProductGroupBasketLine {
  readonly kind: 'group';
  readonly groupId: string;
  readonly groupName: string;
  readonly brand: string | null;
  readonly brandLabel?: string;
  readonly quantity: number;
}

export type BasketLine = ExactBasketLine | ProductGroupBasketLine;
export type ProductGroupBasketInput = Omit<ProductGroupBasketLine, 'kind' | 'quantity'>;

export interface ExactBasketItem {
  readonly kind?: 'exact';
  readonly product: CatalogProduct;
  readonly quantity: number;
  readonly subtotalCents: number | null;
}

export interface ProductGroupBasketItem extends ProductGroupBasketLine {
  readonly subtotalCents: null;
}

export type BasketItem = ExactBasketItem | ProductGroupBasketItem;

export type BasketAction =
  | {
      type: 'hydrateGroups';
      groups: readonly ProductGroup[];
    }
  | {
      type: 'hydrateGroupCatalog';
      requestedGroupIds: readonly string[];
      metadata: ProductGroupCatalogMetadata;
    }
  | {
      type: 'hydrateProducts';
      products: readonly SupabaseProduct[];
      requestedProductIds: readonly string[];
    }
  | {
      type: 'add' | 'remove' | 'increase' | 'decrease';
      productId: string;
      product?: CatalogProduct;
    }
  | {
      type: 'addGroup';
      group: ProductGroupBasketInput;
    }
  | {
      type: 'removeGroup' | 'increaseGroup' | 'decreaseGroup';
      groupId: string;
      brand: string | null;
    }
  | {
      type: 'replace';
      lines: readonly BasketLine[];
    };

function validateProductGroup(
  group: ProductGroupBasketInput,
): ProductGroupBasketInput {
  if (
    !group || typeof group.groupId !== 'string' || !group.groupId.trim() ||
    typeof group.groupName !== 'string' || !group.groupName.trim() ||
    !(group.brand === null || (typeof group.brand === 'string' && group.brand.trim())) ||
    (group.brandLabel !== undefined &&
      (typeof group.brandLabel !== 'string' || !group.brandLabel.trim()))
  ) {
    throw new Error('A escolha de grupo guardada contém dados inválidos.');
  }
  return {
    groupId: group.groupId,
    groupName: group.groupName,
    brand: group.brand,
    ...(group.brandLabel === undefined ? {} : { brandLabel: group.brandLabel }),
  };
}

function sameGroupIdentity(
  line: ProductGroupBasketLine,
  groupId: string,
  brand: string | null,
): boolean {
  return line.groupId === groupId && line.brand === brand;
}

export function isExactBasketItem(item: BasketItem): item is ExactBasketItem {
  return item.kind !== 'group';
}

export function getBasketItemBrandLabel(item: BasketItem): string | null {
  if (item.kind === 'group') {
    return item.brand === null ? 'Qualquer marca' : item.brandLabel ?? item.brand;
  }
  return item.product.brand;
}

export function getBasketItemIdentity(item: BasketItem): string {
  return item.kind === 'group'
    ? `group:${JSON.stringify([item.groupId, item.brand])}`
    : `product:${item.product.id}`;
}

export function basketReducer(
  lines: readonly BasketLine[],
  action: BasketAction,
): readonly BasketLine[] {
  if (action.type === 'hydrateGroups') {
    const groupsById = new Map<string, ProductGroup>();
    for (const group of action.groups) {
      if (!group || typeof group.id !== 'string' || !group.id.trim() ||
          typeof group.name !== 'string' || !group.name.trim()) {
        throw new Error('O catálogo devolveu um grupo inválido para o cabaz.');
      }
      groupsById.set(group.id, group);
    }
    let changed = false;
    const next = lines.flatMap<BasketLine>((line) => {
      if (line.kind !== 'group') return [line];
      const group = groupsById.get(line.groupId);
      if (!group) {
        changed = true;
        return [];
      }
      if (group.name === line.groupName) return [line];
      changed = true;
      return [{ ...line, groupName: group.name }];
    });
    return changed ? next : lines;
  }

  if (action.type === 'hydrateGroupCatalog') {
    const requestedGroupIds = new Set(action.requestedGroupIds);
    if (
      requestedGroupIds.size !== action.requestedGroupIds.length ||
      [...requestedGroupIds].some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('A lista de grupos para atualizar o cabaz é inválida.');
    }
    const availableGroupIds = new Set(action.metadata.availableGroupIds);
    if (
      availableGroupIds.size !== action.metadata.availableGroupIds.length ||
      [...availableGroupIds].some((id) =>
        typeof id !== 'string' || !requestedGroupIds.has(id),
      )
    ) {
      throw new Error('O catálogo devolveu grupos disponíveis inválidos para o cabaz.');
    }

    const labelsByIdentity = new Map<string, string>();
    for (const entry of action.metadata.brandLabels) {
      if (
        !entry || typeof entry.groupId !== 'string' || !entry.groupId.trim() ||
        !requestedGroupIds.has(entry.groupId) ||
        typeof entry.brand !== 'string' || !entry.brand.trim() ||
        typeof entry.label !== 'string' || !entry.label.trim()
      ) {
        throw new Error('O catálogo devolveu um nome de marca inválido para o cabaz.');
      }
      const identity = JSON.stringify([entry.groupId, entry.brand]);
      if (labelsByIdentity.has(identity)) {
        throw new Error('O catálogo devolveu nomes de marca repetidos para o cabaz.');
      }
      labelsByIdentity.set(identity, entry.label);
    }

    let changed = false;
    const next = lines.flatMap<BasketLine>((line) => {
      if (line.kind !== 'group' || !requestedGroupIds.has(line.groupId)) return [line];
      if (!availableGroupIds.has(line.groupId)) {
        changed = true;
        return [];
      }
      if (line.brand === null) return [line];
      const label = labelsByIdentity.get(JSON.stringify([line.groupId, line.brand]));
      if (!label) {
        changed = true;
        return [];
      }
      if (label === line.brandLabel) return [line];
      changed = true;
      return [{ ...line, brandLabel: label }];
    });
    return changed ? next : lines;
  }

  if (action.type === 'hydrateProducts') {
    const requestedProductIds = new Set(action.requestedProductIds);
    if (
      requestedProductIds.size !== action.requestedProductIds.length ||
      [...requestedProductIds].some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('A lista de produtos para atualizar o cabaz é inválida.');
    }
    const productsById = new Map<string, SupabaseProduct>();
    for (const product of action.products) {
      if (
        !product || typeof product.id !== 'string' || !product.id.trim() ||
        !requestedProductIds.has(product.id) ||
        typeof product.name !== 'string' || !product.name.trim() ||
        product.isDemo !== false || product.demoPriceCents !== null ||
        product.active !== true
      ) {
        throw new Error('O catálogo devolveu um produto inválido para o cabaz.');
      }
      productsById.set(product.id, product);
    }
    let changed = false;
    const next = lines.flatMap<BasketLine>((line) => {
      if (line.kind === 'group') return [line];
      const product = productsById.get(line.productId);
      if (!product && requestedProductIds.has(line.productId)) {
        changed = true;
        return [];
      }
      if (!product) return [line];
      changed = true;
      return [{ productId: line.productId, quantity: line.quantity, product }];
    });
    return changed ? next : lines;
  }

  if (action.type === 'replace') {
    const seenExact = new Set<string>();
    const seenGroups = new Set<string>();
    return action.lines.map((line) => {
      if (line?.kind === 'group') {
        const group = validateProductGroup(line);
        const identity = JSON.stringify([group.groupId, group.brand]);
        if (
          !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
          seenGroups.has(identity)
        ) {
          throw new Error('O cabaz guardado contém grupos ou quantidades inválidos.');
        }
        seenGroups.add(identity);
        return { kind: 'group', ...group, quantity: line.quantity };
      }
      if (
        !line || (line.kind !== undefined && line.kind !== 'exact') ||
        typeof line.productId !== 'string' || !line.productId.trim() ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
        seenExact.has(line.productId)
      ) {
        throw new Error('O cabaz guardado contém produtos ou quantidades inválidos.');
      }
      seenExact.add(line.productId);
      if (!line.product) {
        getDemoProduct(line.productId);
        return { productId: line.productId, quantity: line.quantity };
      }
      if (
        line.product.id !== line.productId ||
        line.product.isDemo !== false ||
        line.product.demoPriceCents !== null
      ) {
        throw new Error('O produto remoto guardado contém dados inválidos.');
      }
      return {
        productId: line.productId,
        quantity: line.quantity,
        product: { ...line.product },
      };
    });
  }

  if (action.type === 'addGroup') {
    const group = validateProductGroup(action.group);
    const current = lines.find(
      (line): line is ProductGroupBasketLine =>
        line.kind === 'group' && sameGroupIdentity(line, group.groupId, group.brand),
    );
    if (!current) return [...lines, { kind: 'group', ...group, quantity: 1 }];
    const quantity = current.quantity + 1;
    if (!Number.isSafeInteger(quantity)) {
      throw new Error('A quantidade ultrapassa o limite de cálculo do cabaz.');
    }
    return lines.map((line) =>
      line.kind === 'group' && sameGroupIdentity(line, group.groupId, group.brand)
        ? { ...line, quantity }
        : line,
    );
  }

  if (
    action.type === 'removeGroup' ||
    action.type === 'increaseGroup' ||
    action.type === 'decreaseGroup'
  ) {
    const current = lines.find(
      (line): line is ProductGroupBasketLine =>
        line.kind === 'group' && sameGroupIdentity(line, action.groupId, action.brand),
    );
    if (!current) return lines;
    if (action.type === 'removeGroup') {
      return lines.filter(
        (line) =>
          line.kind !== 'group' || !sameGroupIdentity(line, action.groupId, action.brand),
      );
    }
    if (action.type === 'decreaseGroup' && current.quantity === 1) return lines;
    const quantity = current.quantity + (action.type === 'decreaseGroup' ? -1 : 1);
    if (!Number.isSafeInteger(quantity)) {
      throw new Error('A quantidade ultrapassa o limite de cálculo do cabaz.');
    }
    return lines.map((line) =>
      line.kind === 'group' && sameGroupIdentity(line, action.groupId, action.brand)
        ? { ...line, quantity }
        : line,
    );
  }

  if (!('productId' in action)) return lines;
  const current = lines.find(
    (line): line is ExactBasketLine =>
      line.kind !== 'group' && line.productId === action.productId,
  );
  // Um segundo toque rápido após remover um produto remoto não deve fazer lookup local.
  if (!current && action.type !== 'add') return lines;
  // Legacy ID actions still resolve against the demo catalogue. Remote products
  // travel with their line so subsequent quantity/removal actions need no lookup.
  const product = action.product ?? current?.product ?? getDemoProduct(action.productId);
  if (product.id !== action.productId) throw new Error('O identificador do produto não corresponde à ação.');
  if (product.isDemo) getDemoProduct(product.id);

  if (action.type === 'remove') {
    return lines.filter((line) => line.kind === 'group' || line.productId !== product.id);
  }
  if (!current) {
    return action.type === 'add'
      ? [...lines, product.isDemo
        ? { productId: product.id, quantity: 1 }
        : { productId: product.id, quantity: 1, product: { ...product } }]
      : lines;
  }
  if (action.type === 'decrease' && current.quantity === 1) return lines;

  const quantity = current.quantity + (action.type === 'decrease' ? -1 : 1);
  if (!Number.isSafeInteger(quantity) ||
      (product.demoPriceCents !== null && !Number.isSafeInteger(quantity * product.demoPriceCents))) {
    throw new Error('A quantidade ultrapassa o limite de cálculo do cabaz.');
  }
  return lines.map((line) =>
    line.kind !== 'group' && line.productId === product.id ? { ...line, quantity } : line,
  );
}

export function summarizeBasket(lines: readonly BasketLine[]) {
  const items: BasketItem[] = lines.map((line) => {
    if (line.kind === 'group') {
      const group = validateProductGroup(line);
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
        throw new Error('A quantidade tem de ser um número inteiro positivo.');
      }
      return { kind: 'group', ...group, quantity: line.quantity, subtotalCents: null };
    }
    const { productId, quantity, product: snapshot } = line;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('A quantidade tem de ser um número inteiro positivo.');
    }
    const product = snapshot ?? getDemoProduct(productId);
    if (product.id !== productId) throw new Error('O identificador do produto não corresponde à linha.');
    const subtotalCents = product.demoPriceCents === null ? null : quantity * product.demoPriceCents;
    if (subtotalCents !== null && !Number.isSafeInteger(subtotalCents)) {
      throw new Error('O total ultrapassa o limite de cálculo do cabaz.');
    }
    return { product, quantity, subtotalCents };
  });
  const pricedTotal = items.reduce((total, item) => total + (item.subtotalCents ?? 0), 0);
  const totalCents = items.some((item) => item.subtotalCents === null) ? null : pricedTotal;
  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
  if (!Number.isSafeInteger(pricedTotal) || !Number.isSafeInteger(totalQuantity)) {
    throw new Error('O total ultrapassa o limite de cálculo do cabaz.');
  }
  return { items, totalCents, totalQuantity };
}