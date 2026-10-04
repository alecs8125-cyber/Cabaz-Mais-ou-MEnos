import { DEMO_STORES, type DemoStore } from '../data/demo-stores';
import type { BasketItem, ExactBasketItem, ProductGroupBasketItem } from './basket';
import { getProductGroupCandidatesForBrand } from './product-group-options';
import { getDemoProduct } from './products';
import type { ProductGroupMember } from './product-types';
import type { ComparisonStore, VerifiedPrice } from '../services/prices';

export function hasProductGroupBasketItems(items: readonly BasketItem[]): boolean {
  return items.some((item) => item.kind === 'group');
}

export interface ComparedProduct {
  readonly productId?: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number | null;
  readonly subtotalCents: number | null;
  readonly kind?: 'group';
  readonly lineKey?: string;
  readonly requestedBrandLabel?: string;
  readonly chosenProductName?: string;
  readonly chosenProductBrand?: string | null;
}

export interface StoreComparison {
  readonly storeId: string;
  readonly storeName: string;
  readonly isOnline?: boolean;
  readonly isRegionalReference?: boolean;
  readonly referenceScopeNote?: string;
  readonly totalCents: number | null;
  readonly foundProducts: number;
  readonly missingProducts: number;
  readonly requestedProducts: number;
  readonly isComplete: boolean;
  readonly savingsCents: number;
  readonly savingsReferenceName: string | null;
  readonly latestCapturedAt?: string | null;
  readonly lines?: readonly ComparedProduct[];
  readonly includesProductGroups?: boolean;
}

export function formatBasketCoverage(
  foundProducts: number,
  requestedProducts: number,
): string {
  return `${foundProducts}/${requestedProducts} linhas com preço válido`;
}

/** Totais por loja, incluindo quantidades; contagem por produto distinto. */
export function compareBasket(
  items: readonly ExactBasketItem[],
  stores: readonly DemoStore[] = DEMO_STORES,
): readonly StoreComparison[] {
  const quantities = new Map<string, number>();
  const remoteIds = new Set<string>();
  for (const { product, quantity } of items) {
    if (product.isDemo === false) remoteIds.add(product.id);
    else getDemoProduct(product.id);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('A quantidade tem de ser um número inteiro positivo.');
    }
    const combined = (quantities.get(product.id) ?? 0) + quantity;
    if (!Number.isSafeInteger(combined)) {
      throw new Error('A quantidade ultrapassa o limite de cálculo da comparação.');
    }
    quantities.set(product.id, combined);
  }
  if (quantities.size === 0) return [];

  const results = stores.map<StoreComparison>((store) => {
    let totalCents = 0;
    let foundProducts = 0;
    for (const [productId, quantity] of quantities) {
      // A remote product has no price in the local demo store maps.
      if (remoteIds.has(productId)) continue;
      const price = store.demoPricesCents[productId];
      // Nunca substituir um preço ausente pelo preço genérico do catálogo.
      if (price == null) continue;
      if (!Number.isSafeInteger(price) || price <= 0) {
        throw new Error('O preço de demonstração tem de ser positivo e expresso em cêntimos inteiros.');
      }
      totalCents += price * quantity;
      if (!Number.isSafeInteger(totalCents)) {
        throw new Error('O total ultrapassa o limite de cálculo da comparação.');
      }
      foundProducts += 1;
    }
    return {
      storeId: store.id,
      storeName: store.name,
      totalCents: foundProducts === 0 ? null : totalCents,
      foundProducts,
      missingProducts: quantities.size - foundProducts,
      requestedProducts: quantities.size,
      isComplete: foundProducts === quantities.size,
      savingsCents: 0,
      savingsReferenceName: null,
    };
  });
  return sortAndCalculateSavings(results);
}

/** Sem associar produtos locais por nome: apenas IDs existentes em public.products têm preço remoto. */
export function compareSupabaseBasket(
  items: readonly ExactBasketItem[],
  stores: readonly ComparisonStore[],
  prices: readonly VerifiedPrice[],
  now = Date.now(),
): readonly StoreComparison[] {
  const quantities = new Map<string, { name: string; quantity: number }>();
  for (const { product, quantity } of items) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('A quantidade tem de ser um número inteiro positivo.');
    }
    const previous = quantities.get(product.id);
    const combined = (previous?.quantity ?? 0) + quantity;
    if (!Number.isSafeInteger(combined)) {
      throw new Error('A quantidade ultrapassa o limite de cálculo da comparação.');
    }
    quantities.set(product.id, { name: product.name, quantity: combined });
  }
  if (!quantities.size) return [];

  const byStoreAndProduct = new Map<string, VerifiedPrice>();
  for (const price of prices) {
    if (!quantities.has(price.productId)) continue;
    if (isPriceExpired(price, now)) continue;
    if (!Number.isSafeInteger(price.priceCents) || price.priceCents <= 0) {
      throw new Error('O preço tem de ser positivo e expresso em cêntimos inteiros.');
    }
    const key = `${price.storeId}:${price.productId}`;
    const previous = byStoreAndProduct.get(key);
    if (!previous || Date.parse(price.capturedAt) > Date.parse(previous.capturedAt)) {
      byStoreAndProduct.set(key, price);
    }
  }

  const results = stores.map<StoreComparison>((store) => {
    let totalCents = 0;
    let foundProducts = 0;
    let latestCapturedAt: string | null = null;
    const lines: ComparedProduct[] = [];
    for (const [productId, { name, quantity }] of quantities) {
      const price = byStoreAndProduct.get(`${store.id}:${productId}`);
      if (!price) {
        lines.push({ productId, name, quantity, unitPriceCents: null, subtotalCents: null });
        continue;
      }
      const subtotalCents = price.priceCents * quantity;
      totalCents += subtotalCents;
      if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents)) {
        throw new Error('O total ultrapassa o limite de cálculo da comparação.');
      }
      foundProducts += 1;
      if (!latestCapturedAt || Date.parse(price.capturedAt) > Date.parse(latestCapturedAt)) {
        latestCapturedAt = price.capturedAt;
      }
      lines.push({ productId, name, quantity, unitPriceCents: price.priceCents, subtotalCents });
    }
    return {
      storeId: store.id,
      storeName: store.name,
      totalCents: foundProducts ? totalCents : null,
      foundProducts,
      missingProducts: quantities.size - foundProducts,
      requestedProducts: quantities.size,
      isComplete: foundProducts === quantities.size,
      savingsCents: 0,
      savingsReferenceName: null,
      latestCapturedAt,
      lines,
      ...(store.isOnline ? { isOnline: true } : {}),
      ...(store.isRegionalReference ? {
        isRegionalReference: true,
        referenceScopeNote: store.referenceScopeNote,
      } : {}),
    };
  });
  return sortAndCalculateSavings(results);
}

export type ProductGroupMembersById = Readonly<
  Record<string, readonly ProductGroupMember[] | undefined>
>;

type ComparisonBasketLine =
  | {
      kind: 'exact';
      lineKey: string;
      productId: string;
      name: string;
      quantity: number;
    }
  | {
      kind: 'group';
      lineKey: string;
      group: ProductGroupBasketItem;
      quantity: number;
      candidates: readonly ProductGroupMember[];
    };

function getGroupCandidates(
  item: ProductGroupBasketItem,
  membersByGroupId: ProductGroupMembersById,
): ProductGroupMember[] {
  return getProductGroupCandidatesForBrand(membersByGroupId[item.groupId] ?? [], item.brand);
}

function validateQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error('A quantidade tem de ser um número inteiro positivo.');
  }
}

/** Junta os IDs exatos e os candidatos reais dos grupos para uma única consulta de preços. */
export function collectComparisonProductIds(
  items: readonly BasketItem[],
  membersByGroupId: ProductGroupMembersById,
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === 'group') {
      for (const member of getGroupCandidates(item, membersByGroupId)) ids.add(member.id);
    } else if (!item.product.isDemo) {
      ids.add(item.product.id);
    }
  }
  return [...ids].sort();
}

function prepareComparisonLines(
  items: readonly BasketItem[],
  membersByGroupId: ProductGroupMembersById,
): ComparisonBasketLine[] {
  const lines: ComparisonBasketLine[] = [];
  const lineIndexes = new Map<string, number>();

  for (const item of items) {
    validateQuantity(item.quantity);
    if (item.kind === 'group') {
      if (
        !item.groupId.trim() || !item.groupName.trim() ||
        !(item.brand === null || item.brand.trim()) ||
        (item.brandLabel !== undefined && !item.brandLabel.trim())
      ) {
        throw new Error('A escolha por grupo contém dados inválidos.');
      }
      const lineKey = `group:${JSON.stringify([item.groupId, item.brand])}`;
      const existingIndex = lineIndexes.get(lineKey);
      if (existingIndex !== undefined) {
        const existing = lines[existingIndex];
        if (existing.kind !== 'group') throw new Error('A identidade da linha do cabaz é inválida.');
        const quantity = existing.quantity + item.quantity;
        if (!Number.isSafeInteger(quantity)) {
          throw new Error('A quantidade ultrapassa o limite de cálculo da comparação.');
        }
        lines[existingIndex] = { ...existing, quantity };
      } else {
        lineIndexes.set(lineKey, lines.length);
        lines.push({
          kind: 'group',
          lineKey,
          group: item,
          quantity: item.quantity,
          candidates: getGroupCandidates(item, membersByGroupId),
        });
      }
      continue;
    }

    const productId = item.product.id;
    if (!productId.trim()) throw new Error('O produto exato não tem um identificador válido.');
    const lineKey = `exact:${JSON.stringify(productId)}`;
    const existingIndex = lineIndexes.get(lineKey);
    if (existingIndex !== undefined) {
      const existing = lines[existingIndex];
      if (existing.kind !== 'exact') throw new Error('A identidade da linha do cabaz é inválida.');
      const quantity = existing.quantity + item.quantity;
      if (!Number.isSafeInteger(quantity)) {
        throw new Error('A quantidade ultrapassa o limite de cálculo da comparação.');
      }
      lines[existingIndex] = { ...existing, quantity };
    } else {
      lineIndexes.set(lineKey, lines.length);
      lines.push({
        kind: 'exact',
        lineKey,
        productId,
        name: item.product.name,
        quantity: item.quantity,
      });
    }
  }
  return lines;
}

function priceKey(storeId: string, productId: string): string {
  return JSON.stringify([storeId, productId]);
}

function isPriceExpired(price: VerifiedPrice, now: number): boolean {
  if (price.validUntil == null) return false;
  const validUntil = Date.parse(price.validUntil);
  if (!Number.isFinite(validUntil)) {
    throw new Error('A data de validade do preço é inválida.');
  }
  return validUntil < now;
}

/**
 * Compara escolhas genéricas pelos seus produtos reais candidatos por loja.
 * A linha original do cabaz permanece genérica; apenas o resultado contém o SKU escolhido.
 */
export function compareSupabaseBasketWithGroups(
  items: readonly BasketItem[],
  stores: readonly ComparisonStore[],
  prices: readonly VerifiedPrice[],
  membersByGroupId: ProductGroupMembersById,
  now = Date.now(),
): readonly StoreComparison[] {
  const lines = prepareComparisonLines(items, membersByGroupId);
  if (!lines.length) return [];

  const productIds = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'exact') productIds.add(line.productId);
    else for (const member of line.candidates) productIds.add(member.id);
  }

  const byStoreAndProduct = new Map<string, VerifiedPrice>();
  for (const price of prices) {
    if (!productIds.has(price.productId)) continue;
    if (isPriceExpired(price, now)) continue;
    if (!Number.isSafeInteger(price.priceCents) || price.priceCents <= 0) {
      throw new Error('O preço tem de ser positivo e expresso em cêntimos inteiros.');
    }
    const key = priceKey(price.storeId, price.productId);
    const previous = byStoreAndProduct.get(key);
    if (!previous || Date.parse(price.capturedAt) > Date.parse(previous.capturedAt)) {
      byStoreAndProduct.set(key, price);
    }
  }

  const includesProductGroups = lines.some((line) => line.kind === 'group');
  const results = stores.map<StoreComparison>((store) => {
    let totalCents = 0;
    let foundProducts = 0;
    let latestCapturedAt: string | null = null;
    const comparedLines: ComparedProduct[] = [];

    for (const line of lines) {
      let price: VerifiedPrice | undefined;
      let chosen: ProductGroupMember | undefined;
      if (line.kind === 'exact') {
        price = byStoreAndProduct.get(priceKey(store.id, line.productId));
      } else {
        for (const candidate of line.candidates) {
          const candidatePrice = byStoreAndProduct.get(priceKey(store.id, candidate.id));
          if (
            candidatePrice &&
            (!price ||
              candidatePrice.priceCents < price.priceCents ||
              (candidatePrice.priceCents === price.priceCents &&
                candidate.id < (chosen?.id ?? '')))
          ) {
            price = candidatePrice;
            chosen = candidate;
          }
        }
      }

      if (!price) {
        comparedLines.push(line.kind === 'group'
          ? {
              kind: 'group',
              lineKey: line.lineKey,
              name: line.group.groupName,
              requestedBrandLabel: line.group.brand === null
                ? 'Qualquer marca'
                : line.group.brandLabel ?? line.group.brand,
              quantity: line.quantity,
              unitPriceCents: null,
              subtotalCents: null,
            }
          : {
              productId: line.productId,
              name: line.name,
              quantity: line.quantity,
              unitPriceCents: null,
              subtotalCents: null,
            });
        continue;
      }

      const subtotalCents = price.priceCents * line.quantity;
      totalCents += subtotalCents;
      if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents)) {
        throw new Error('O total ultrapassa o limite de cálculo da comparação.');
      }
      foundProducts += 1;
      if (!latestCapturedAt || Date.parse(price.capturedAt) > Date.parse(latestCapturedAt)) {
        latestCapturedAt = price.capturedAt;
      }

      comparedLines.push(line.kind === 'group'
        ? {
            kind: 'group',
            lineKey: line.lineKey,
            productId: chosen!.id,
            name: line.group.groupName,
            requestedBrandLabel: line.group.brand === null
              ? 'Qualquer marca'
              : line.group.brandLabel ?? line.group.brand,
            chosenProductName: chosen!.name,
            chosenProductBrand: chosen!.brand,
            quantity: line.quantity,
            unitPriceCents: price.priceCents,
            subtotalCents,
          }
        : {
            productId: line.productId,
            name: line.name,
            quantity: line.quantity,
            unitPriceCents: price.priceCents,
            subtotalCents,
          });
    }

    return {
      storeId: store.id,
      storeName: store.name,
      totalCents: foundProducts ? totalCents : null,
      foundProducts,
      missingProducts: lines.length - foundProducts,
      requestedProducts: lines.length,
      isComplete: foundProducts === lines.length,
      savingsCents: 0,
      savingsReferenceName: null,
      latestCapturedAt,
      lines: comparedLines,
      ...(store.isOnline ? { isOnline: true } : {}),
      ...(store.isRegionalReference ? {
        isRegionalReference: true,
        referenceScopeNote: store.referenceScopeNote,
      } : {}),
      ...(includesProductGroups ? { includesProductGroups: true } : {}),
    };
  });

  return sortAndCalculateSavings(results, includesProductGroups);
}

function sortAndCalculateSavings(
  results: StoreComparison[],
  prioritizeComplete = false,
): readonly StoreComparison[] {
  results.sort((a, b) => {
    if (prioritizeComplete && a.isComplete !== b.isComplete) {
      return a.isComplete ? -1 : 1;
    }
    // Sem qualquer produto encontrado, não existe um total para ordenar como preço.
    if (a.totalCents === null) {
      return b.totalCents === null ? a.storeName.localeCompare(b.storeName, 'pt-PT') : 1;
    }
    if (b.totalCents === null) return -1;
    return a.totalCents - b.totalCents || a.storeName.localeCompare(b.storeName, 'pt-PT');
  });

  // Produtos em falta não são uma poupança: comparar apenas o mesmo cabaz completo.
  const complete = results.filter(
    (result): result is StoreComparison & { totalCents: number } =>
      result.isComplete && result.totalCents !== null,
  );
  const cheapest = complete[0];
  if (!cheapest) return results;
  const reference = complete.find((result) => result.totalCents > cheapest.totalCents);
  if (!reference) return results;

  // Em caso de empate no menor total, ambas as lojas têm a mesma poupança
  // face à alternativa completa com o preço imediatamente superior.
  return results.map((result) =>
    result.isComplete && result.totalCents === cheapest.totalCents
      ? {
          ...result,
          savingsCents: reference.totalCents - cheapest.totalCents,
          savingsReferenceName: reference.storeName,
        }
      : result,
  );
}