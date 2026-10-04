import type { BasketItem, BasketLine } from './basket';
import { getDemoProduct } from './products';
import type { SupabaseProduct } from './product-types';

export const SAVED_BASKETS_STORAGE_KEY = 'cabaz-mais-ou-menos:saved-baskets:v1';
export const SAVED_BASKETS_V2_STORAGE_KEY = 'cabaz-mais-ou-menos:saved-baskets:v2';
export const MAX_SAVED_BASKET_NAME_LENGTH = 60;
export const EMPTY_SAVED_BASKETS_MESSAGE = 'Ainda não tens cabazes guardados.';

export interface SavedBasketExactProduct {
  readonly kind?: 'exact';
  readonly productId: string;
  readonly name: string;
  readonly brand: string | null;
  readonly category: string | null;
  readonly unit: string | null;
  readonly isDemo: boolean;
  readonly quantity: number;
}

export interface SavedBasketGroupProduct {
  readonly kind: 'group';
  readonly groupId: string;
  readonly groupName: string;
  readonly brand: string | null;
  readonly brandLabel?: string;
  readonly quantity: number;
}

export type SavedBasketProduct = SavedBasketExactProduct | SavedBasketGroupProduct;

export interface SavedBasket {
  readonly id: string;
  readonly name: string;
  readonly products: readonly SavedBasketProduct[];
  readonly savedAt: string;
}

export interface LocalKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function normalizeSavedBasketName(name: string): string {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > MAX_SAVED_BASKET_NAME_LENGTH) {
    throw new Error('O nome do cabaz tem de ter entre 1 e 60 caracteres.');
  }
  return cleanName;
}

export function createSavedBasket(
  name: string,
  items: readonly BasketItem[],
  savedAt = new Date().toISOString(),
  id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
): SavedBasket {
  const cleanName = normalizeSavedBasketName(name);
  if (!items.length) throw new Error('Adiciona produtos antes de guardar o cabaz.');
  if (!id.trim() || !Number.isFinite(Date.parse(savedAt))) {
    throw new Error('Os dados do cabaz guardado são inválidos.');
  }

  const seen = new Set<string>();
  const products = items.map((item): SavedBasketProduct => {
    if (item.kind === 'group') {
      if (
        !item.groupId.trim() || !item.groupName.trim() ||
        !(item.brand === null || item.brand.trim()) ||
        (item.brandLabel !== undefined && !item.brandLabel.trim()) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1
      ) {
        throw new Error('O cabaz contém grupos ou quantidades inválidos.');
      }
      const identity = `group:${JSON.stringify([item.groupId, item.brand])}`;
      if (seen.has(identity)) throw new Error('O cabaz contém grupos ou quantidades inválidos.');
      seen.add(identity);
      return {
        kind: 'group',
        groupId: item.groupId,
        groupName: item.groupName,
        brand: item.brand,
        ...(item.brandLabel === undefined ? {} : { brandLabel: item.brandLabel }),
        quantity: item.quantity,
      };
    }

    const { product, quantity } = item;
    const identity = `product:${product.id}`;
    if (
      !product.id.trim() ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      seen.has(identity)
    ) {
      throw new Error('O cabaz contém produtos ou quantidades inválidos.');
    }
    seen.add(identity);
    return {
      productId: product.id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      unit: product.unit,
      isDemo: product.isDemo,
      quantity,
    };
  });
  return { id, name: cleanName, products, savedAt };
}

export function parseSavedBaskets(serialized: string): SavedBasket[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('A lista de cabazes guardados está danificada.');
  }
  if (!Array.isArray(value)) throw new Error('A lista de cabazes guardados é inválida.');

  return value.map((entry): SavedBasket => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Foi encontrado um cabaz guardado inválido.');
    }
    const basket = entry as Record<string, unknown>;
    if (
      typeof basket.id !== 'string' || !basket.id.trim() ||
      typeof basket.name !== 'string' || !basket.name.trim() ||
      basket.name.length > MAX_SAVED_BASKET_NAME_LENGTH ||
      typeof basket.savedAt !== 'string' || !Number.isFinite(Date.parse(basket.savedAt)) ||
      !Array.isArray(basket.products) || basket.products.length === 0
    ) {
      throw new Error('Foi encontrado um cabaz guardado inválido.');
    }

    const seen = new Set<string>();
    const products = basket.products.map((entryProduct): SavedBasketProduct => {
      if (!entryProduct || typeof entryProduct !== 'object' || Array.isArray(entryProduct)) {
        throw new Error('Foi encontrado um produto guardado inválido.');
      }
      const product = entryProduct as Record<string, unknown>;
      if (
        typeof product.productId !== 'string' || !product.productId.trim() ||
        typeof product.name !== 'string' || !product.name.trim() ||
        ![product.brand, product.category, product.unit].every(
          (field) => field === null || typeof field === 'string',
        ) ||
        typeof product.isDemo !== 'boolean' ||
        !Number.isSafeInteger(product.quantity) || (product.quantity as number) < 1 ||
        seen.has(product.productId)
      ) {
        throw new Error('Foi encontrado um produto guardado inválido.');
      }
      seen.add(product.productId);
      // Reconstruir apenas os campos permitidos descarta quaisquer preços antigos.
      return {
        productId: product.productId,
        name: product.name,
        brand: product.brand as string | null,
        category: product.category as string | null,
        unit: product.unit as string | null,
        isDemo: product.isDemo,
        quantity: product.quantity as number,
      };
    });

    return {
      id: basket.id,
      name: basket.name.trim(),
      products,
      savedAt: basket.savedAt,
    };
  });
}

export function parseSavedBasketsV2(serialized: string): SavedBasket[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('A lista v2 de cabazes guardados está danificada.');
  }
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 2 ||
    !Array.isArray((value as Record<string, unknown>).baskets)
  ) {
    throw new Error('A lista v2 de cabazes guardados é inválida.');
  }

  const baskets = (value as { baskets: unknown[] }).baskets;
  return baskets.map((entry): SavedBasket => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Foi encontrado um cabaz v2 inválido.');
    }
    const basket = entry as Record<string, unknown>;
    if (
      typeof basket.id !== 'string' || !basket.id.trim() ||
      typeof basket.name !== 'string' || !basket.name.trim() ||
      basket.name.length > MAX_SAVED_BASKET_NAME_LENGTH ||
      typeof basket.savedAt !== 'string' || !Number.isFinite(Date.parse(basket.savedAt)) ||
      !Array.isArray(basket.products) || basket.products.length === 0
    ) {
      throw new Error('Foi encontrado um cabaz v2 inválido.');
    }

    const seen = new Set<string>();
    const products = basket.products.map((entryProduct): SavedBasketProduct => {
      if (!entryProduct || typeof entryProduct !== 'object' || Array.isArray(entryProduct)) {
        throw new Error('Foi encontrado um produto v2 inválido.');
      }
      const product = entryProduct as Record<string, unknown>;
      if (product.kind === 'group') {
        if (
          'productId' in product ||
          typeof product.groupId !== 'string' || !product.groupId.trim() ||
          typeof product.groupName !== 'string' || !product.groupName.trim() ||
          !(product.brand === null || (typeof product.brand === 'string' && product.brand.trim())) ||
          (product.brandLabel !== undefined &&
            (typeof product.brandLabel !== 'string' || !product.brandLabel.trim())) ||
          !Number.isSafeInteger(product.quantity) || (product.quantity as number) < 1
        ) {
          throw new Error('Foi encontrado um produto de grupo v2 inválido.');
        }
        const identity = `group:${JSON.stringify([product.groupId, product.brand])}`;
        if (seen.has(identity)) throw new Error('Foi encontrado um produto v2 duplicado.');
        seen.add(identity);
        return {
          kind: 'group',
          groupId: product.groupId,
          groupName: product.groupName,
          brand: product.brand as string | null,
          ...(product.brandLabel === undefined ? {} : { brandLabel: product.brandLabel as string }),
          quantity: product.quantity as number,
        };
      }

      if (
        (product.kind !== undefined && product.kind !== 'exact') ||
        typeof product.productId !== 'string' || !product.productId.trim() ||
        typeof product.name !== 'string' || !product.name.trim() ||
        ![product.brand, product.category, product.unit].every(
          (field) => field === null || typeof field === 'string',
        ) ||
        typeof product.isDemo !== 'boolean' ||
        !Number.isSafeInteger(product.quantity) || (product.quantity as number) < 1
      ) {
        throw new Error('Foi encontrado um produto exato v2 inválido.');
      }
      const identity = `product:${product.productId}`;
      if (seen.has(identity)) throw new Error('Foi encontrado um produto v2 duplicado.');
      seen.add(identity);
      return {
        productId: product.productId,
        name: product.name,
        brand: product.brand as string | null,
        category: product.category as string | null,
        unit: product.unit as string | null,
        isDemo: product.isDemo,
        quantity: product.quantity as number,
      };
    });

    return {
      id: basket.id,
      name: basket.name.trim(),
      products,
      savedAt: basket.savedAt,
    };
  });
}

async function loadV1SavedBaskets(storage: LocalKeyValueStorage): Promise<SavedBasket[]> {
  const serialized = await storage.getItem(SAVED_BASKETS_STORAGE_KEY);
  return serialized === null ? [] : parseSavedBaskets(serialized);
}

async function loadV2SavedBaskets(storage: LocalKeyValueStorage): Promise<SavedBasket[]> {
  const serialized = await storage.getItem(SAVED_BASKETS_V2_STORAGE_KEY);
  return serialized === null ? [] : parseSavedBasketsV2(serialized);
}

async function writeV2SavedBaskets(
  storage: LocalKeyValueStorage,
  baskets: readonly SavedBasket[],
): Promise<void> {
  await storage.setItem(
    SAVED_BASKETS_V2_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 2, baskets }),
  );
}

export async function loadSavedBaskets(storage: LocalKeyValueStorage): Promise<SavedBasket[]> {
  const [v1, v2] = await Promise.all([
    loadV1SavedBaskets(storage),
    loadV2SavedBaskets(storage),
  ]);
  return [...v2, ...v1].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

export async function addSavedBasket(
  storage: LocalKeyValueStorage,
  basket: SavedBasket,
): Promise<SavedBasket[]> {
  if (basket.products.some((product) => product.kind === 'group')) {
    const current = await loadV2SavedBaskets(storage);
    const existingV1 = await loadV1SavedBaskets(storage);
    if (
      current.some((saved) => saved.id === basket.id) ||
      existingV1.some((saved) => saved.id === basket.id)
    ) {
      throw new Error('O cabaz guardado já existe.');
    }
    const saved = [basket, ...current];
    const serialized = JSON.stringify({ schemaVersion: 2, baskets: saved });
    parseSavedBasketsV2(serialized);
    await storage.setItem(SAVED_BASKETS_V2_STORAGE_KEY, serialized);
  } else {
    const current = await loadV1SavedBaskets(storage);
    const existingV2 = await loadV2SavedBaskets(storage);
    if (
      current.some((saved) => saved.id === basket.id) ||
      existingV2.some((saved) => saved.id === basket.id)
    ) {
      throw new Error('O cabaz guardado já existe.');
    }
    const saved = [basket, ...current];
    parseSavedBaskets(JSON.stringify(saved));
    await storage.setItem(SAVED_BASKETS_STORAGE_KEY, JSON.stringify(saved));
  }
  return loadSavedBaskets(storage);
}

export async function renameSavedBasket(
  storage: LocalKeyValueStorage,
  basketId: string,
  name: string,
): Promise<SavedBasket[]> {
  const cleanName = normalizeSavedBasketName(name);
  const v2 = await loadV2SavedBaskets(storage);
  const v2Index = v2.findIndex((basket) => basket.id === basketId);
  if (v2Index >= 0) {
    const renamed = v2.map((basket, index) =>
      index === v2Index ? { ...basket, name: cleanName } : basket,
    );
    await writeV2SavedBaskets(storage, renamed);
    return loadSavedBaskets(storage);
  }

  const v1 = await loadV1SavedBaskets(storage);
  const v1Index = v1.findIndex((basket) => basket.id === basketId);
  if (v1Index < 0) throw new Error('O cabaz guardado já não existe.');
  const renamed = v1.map((basket, index) =>
    index === v1Index ? { ...basket, name: cleanName } : basket,
  );
  await storage.setItem(SAVED_BASKETS_STORAGE_KEY, JSON.stringify(renamed));
  return loadSavedBaskets(storage);
}

export async function deleteSavedBasketAfterConfirmation(
  storage: LocalKeyValueStorage,
  basketId: string,
  confirmed: boolean,
): Promise<SavedBasket[]> {
  if (!confirmed) return loadSavedBaskets(storage);

  const v2 = await loadV2SavedBaskets(storage);
  const remainingV2 = v2.filter((basket) => basket.id !== basketId);
  if (remainingV2.length !== v2.length) {
    await writeV2SavedBaskets(storage, remainingV2);
    return loadSavedBaskets(storage);
  }

  const v1 = await loadV1SavedBaskets(storage);
  const remainingV1 = v1.filter((basket) => basket.id !== basketId);
  if (remainingV1.length === v1.length) {
    throw new Error('O cabaz guardado já não existe.');
  }
  await storage.setItem(SAVED_BASKETS_STORAGE_KEY, JSON.stringify(remainingV1));
  return loadSavedBaskets(storage);
}

export function restoreSavedBasket(basket: SavedBasket): BasketLine[] {
  return basket.products.map((product): BasketLine => {
    if (product.kind === 'group') {
      return {
        kind: 'group',
        groupId: product.groupId,
        groupName: product.groupName,
        brand: product.brand,
        ...(product.brandLabel === undefined ? {} : { brandLabel: product.brandLabel }),
        quantity: product.quantity,
      };
    }
    if (product.isDemo) {
      // Os produtos locais reobtêm o catálogo de demonstração atual; preços guardados nunca são usados.
      getDemoProduct(product.productId);
      return { productId: product.productId, quantity: product.quantity };
    }
    const remoteProduct: SupabaseProduct = {
      id: product.productId,
      name: product.name,
      brand: product.brand,
      category: product.category,
      unit: product.unit,
      active: true,
      isDemo: false,
      demoPriceCents: null,
    };
    return {
      productId: product.productId,
      quantity: product.quantity,
      product: remoteProduct,
    };
  });
}