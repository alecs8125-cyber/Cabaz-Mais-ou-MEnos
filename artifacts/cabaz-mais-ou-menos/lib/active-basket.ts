import type { BasketLine } from './basket';
import { normalizeProductGroupBrand } from './product-group-options';

export const ACTIVE_BASKET_STORAGE_KEY = 'cabaz-mais-ou-menos:active-basket:v1';
export const ACTIVE_BASKET_SCHEMA_VERSION = 1;
export const ACTIVE_BASKET_DEBOUNCE_MS = 300;

export interface ActiveBasketStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ActiveBasketLoadResult {
  readonly lines: PersistedActiveBasketLine[];
  readonly serialized: string;
  readonly needsRewrite: boolean;
  readonly recovered: boolean;
}

export type PersistedActiveBasketLine =
  | {
      readonly kind: 'exact';
      readonly productId: string;
      readonly quantity: number;
    }
  | {
      readonly kind: 'group';
      readonly groupId: string;
      readonly brand: string | null;
      readonly quantity: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function positiveQuantity(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseActiveBasketDocument(serialized: string): PersistedActiveBasketLine[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('O cabaz ativo guardado está danificado.');
  }

  if (!isRecord(value) || value.schemaVersion !== ACTIVE_BASKET_SCHEMA_VERSION ||
      !Array.isArray(value.lines)) {
    throw new Error('A versão do cabaz ativo guardado não é compatível.');
  }

  const exactIds = new Set<string>();
  const groupIds = new Set<string>();
  return value.lines.map((entry): PersistedActiveBasketLine => {
    if (!isRecord(entry) || !positiveQuantity(entry.quantity)) {
      throw new Error('O cabaz ativo guardado contém uma linha inválida.');
    }

    if (entry.kind === 'exact') {
      if (typeof entry.productId !== 'string' || !entry.productId.trim() ||
          exactIds.has(entry.productId)) {
        throw new Error('O cabaz ativo guardado contém um produto inválido ou repetido.');
      }
      exactIds.add(entry.productId);
      return { kind: 'exact', productId: entry.productId, quantity: entry.quantity };
    }

    if (
      entry.kind !== 'group' ||
      typeof entry.groupId !== 'string' || !entry.groupId.trim() ||
      !(entry.brand === null || (typeof entry.brand === 'string' && entry.brand.trim()))
    ) {
      throw new Error('O cabaz ativo guardado contém um grupo inválido.');
    }

    const brand = entry.brand === null
      ? null
      : normalizeProductGroupBrand(entry.brand);
    const identity = JSON.stringify([entry.groupId, brand]);
    if (groupIds.has(identity)) {
      throw new Error('O cabaz ativo guardado contém um grupo repetido.');
    }
    groupIds.add(identity);
    return {
      kind: 'group',
      groupId: entry.groupId,
      brand,
      quantity: entry.quantity,
    };
  });
}

export function serializeActiveBasket(
  lines: readonly (BasketLine | PersistedActiveBasketLine)[],
): string {
  const exactIds = new Set<string>();
  const groupIds = new Set<string>();
  const projectedLines = lines.map((line) => {
    if (
      !line || !positiveQuantity(line.quantity)
    ) {
      throw new Error('Não é possível guardar uma linha inválida no cabaz ativo.');
    }

    if (line.kind === 'group') {
      if (
        typeof line.groupId !== 'string' || !line.groupId.trim() ||
        ('groupName' in line && (typeof line.groupName !== 'string' || !line.groupName.trim())) ||
        !(line.brand === null || (typeof line.brand === 'string' && line.brand.trim())) ||
        ('brandLabel' in line && line.brandLabel !== undefined &&
          (typeof line.brandLabel !== 'string' || !line.brandLabel.trim()))
      ) {
        throw new Error('Não é possível guardar um grupo inválido no cabaz ativo.');
      }
      const identity = JSON.stringify([line.groupId, line.brand]);
      if (groupIds.has(identity)) {
        throw new Error('Não é possível guardar grupos repetidos no cabaz ativo.');
      }
      groupIds.add(identity);
      return {
        kind: 'group' as const,
        groupId: line.groupId,
        brand: line.brand,
        quantity: line.quantity,
      };
    }

    if (
      typeof line.productId !== 'string' || !line.productId.trim() ||
      (line.kind !== undefined && line.kind !== 'exact') ||
      exactIds.has(line.productId)
    ) {
      throw new Error('Não é possível guardar um produto inválido no cabaz ativo.');
    }
    exactIds.add(line.productId);
    return {
      kind: 'exact' as const,
      productId: line.productId,
      quantity: line.quantity,
    };
  });

  return JSON.stringify({
    schemaVersion: ACTIVE_BASKET_SCHEMA_VERSION,
    lines: projectedLines,
  });
}

export async function loadActiveBasket(
  storage: ActiveBasketStorage,
): Promise<ActiveBasketLoadResult> {
  const serialized = await storage.getItem(ACTIVE_BASKET_STORAGE_KEY);
  const emptySerialized = serializeActiveBasket([]);
  if (serialized === null) {
    return {
      lines: [],
      serialized: emptySerialized,
      needsRewrite: false,
      recovered: false,
    };
  }

  try {
    const lines = parseActiveBasketDocument(serialized);
    const canonical = serializeActiveBasket(lines);
    return {
      lines,
      serialized: canonical,
      needsRewrite: canonical !== serialized,
      recovered: false,
    };
  } catch {
    try {
      await storage.removeItem(ACTIVE_BASKET_STORAGE_KEY);
      return {
        lines: [],
        serialized: emptySerialized,
        needsRewrite: false,
        recovered: true,
      };
    } catch {
      return {
        lines: [],
        serialized: emptySerialized,
        needsRewrite: true,
        recovered: true,
      };
    }
  }
}

export interface ActiveBasketWriter {
  setBaseline(serialized: string | null): void;
  schedule(lines: readonly BasketLine[]): void;
  flush(): Promise<void>;
}

export function createActiveBasketWriter(
  storage: ActiveBasketStorage,
  debounceMs = ACTIVE_BASKET_DEBOUNCE_MS,
): ActiveBasketWriter {
  let baseline: string | null = null;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (pending === null) return writeQueue;

    const next = pending;
    pending = null;
    if (next === baseline) return writeQueue;

    const write = writeQueue.then(() =>
      storage.setItem(ACTIVE_BASKET_STORAGE_KEY, next),
    ).then(() => {
      baseline = next;
    });
    writeQueue = write.catch(() => undefined);
    return write;
  };

  return {
    setBaseline(serialized) {
      baseline = serialized;
    },
    schedule(lines) {
      const next = serializeActiveBasket(lines);
      if (next === (pending ?? baseline)) return;
      pending = next;
      clearTimer();
      timer = setTimeout(() => {
        void flush().catch((error: unknown) => {
          console.warn('Não foi possível guardar o cabaz ativo.', error);
        });
      }, Math.max(0, debounceMs));
    },
    flush,
  };
}
