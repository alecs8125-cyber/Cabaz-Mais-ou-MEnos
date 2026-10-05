import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import {
  basketReducer,
  summarizeBasket,
  type BasketAction,
  type BasketItem,
  type BasketLine,
  type ProductGroupBasketInput,
} from '@/lib/basket';
import {
  ACTIVE_BASKET_DEBOUNCE_MS,
  createActiveBasketWriter,
  loadActiveBasket,
} from '@/lib/active-basket';
import { getDemoProduct } from '@/lib/products';
import type { CatalogProduct } from '@/lib/product-types';
import { getProductGroups } from '@/services/product-groups';
import { getProductsByIds } from '@/services/products';

interface BasketContextValue {
  items: readonly BasketItem[];
  totalCents: number | null;
  totalQuantity: number;
  isHydrated: boolean;
  addProduct: (product: string | CatalogProduct) => void;
  addProductGroup: (group: ProductGroupBasketInput) => void;
  removeProduct: (id: string) => void;
  increaseQuantity: (id: string) => void;
  decreaseQuantity: (id: string) => void;
  removeProductGroup: (groupId: string, brand: string | null) => void;
  increaseProductGroupQuantity: (groupId: string, brand: string | null) => void;
  decreaseProductGroupQuantity: (groupId: string, brand: string | null) => void;
  replaceBasket: (lines: readonly BasketLine[]) => void;
}

const BasketContext = createContext<BasketContextValue | null>(null);

// Cabaz ativo guardado neste dispositivo, independente da zona selecionada.
export function BasketProvider({ children }: { children: ReactNode }) {
  const [lines, dispatch] = useReducer(basketReducer, []);
  const [isHydrated, setIsHydrated] = useState(false);
  const [canPersist, setCanPersist] = useState(false);
  const isHydratedRef = useRef(false);
  const canPersistRef = useRef(false);
  const latestLinesRef = useRef(lines);
  const pendingActionsRef = useRef<BasketAction[]>([]);
  const writerRef = useRef<ReturnType<typeof createActiveBasketWriter> | null>(null);
  if (writerRef.current === null) {
    writerRef.current = createActiveBasketWriter(AsyncStorage, ACTIVE_BASKET_DEBOUNCE_MS);
  }
  const writer = writerRef.current;
  const dispatchBasketAction = useCallback((action: BasketAction) => {
    if (!isHydratedRef.current) {
      pendingActionsRef.current.push(action);
      return;
    }
    const nextLines = basketReducer(latestLinesRef.current, action);
    latestLinesRef.current = nextLines;
    dispatch(action);
  }, []);

  useEffect(() => {
    let mounted = true;
    let appIsActive = AppState.currentState === 'active';
    const flushLatest = () => {
      if (isHydratedRef.current && canPersistRef.current) {
        writer.schedule(latestLinesRef.current);
        void writer.flush().catch((error: unknown) => {
          console.warn('Não foi possível guardar o cabaz ativo.', error);
        });
      }
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      appIsActive = state === 'active';
      if (state !== 'active') flushLatest();
    });

    void loadActiveBasket(AsyncStorage).then((loaded) => {
      if (!mounted) return;
      writer.setBaseline(loaded.needsRewrite ? null : loaded.serialized);
      const remoteProductIds: string[] = [];
      const productGroupIds: string[] = [];
      const restoredLines: BasketLine[] = loaded.lines.map((line) => {
        if (line.kind === 'group') {
          productGroupIds.push(line.groupId);
          return {
            kind: 'group',
            groupId: line.groupId,
            groupName: line.groupId,
            brand: line.brand,
            quantity: line.quantity,
          };
        }
        try {
          getDemoProduct(line.productId);
          return { productId: line.productId, quantity: line.quantity };
        } catch {
          remoteProductIds.push(line.productId);
          return {
            productId: line.productId,
            quantity: line.quantity,
            product: {
              id: line.productId,
              name: line.productId,
              brand: null,
              barcode: null,
              category: null,
              unit: null,
              active: true,
              isDemo: false,
              demoPriceCents: null,
            },
          };
        }
      });

      latestLinesRef.current = basketReducer([], { type: 'replace', lines: restoredLines });
      dispatch({ type: 'replace', lines: restoredLines });
      isHydratedRef.current = true;
      canPersistRef.current = true;
      for (const action of pendingActionsRef.current.splice(0)) {
        dispatchBasketAction(action);
      }
      setCanPersist(true);
      setIsHydrated(true);

      if (remoteProductIds.length > 0) {
        void getProductsByIds(remoteProductIds).then((products) => {
          if (mounted && products.length > 0) {
            dispatchBasketAction({ type: 'hydrateProducts', products });
          }
        }).catch((error: unknown) => {
          console.warn('Não foi possível atualizar os detalhes dos produtos do cabaz.', error);
        });
      }
      if (productGroupIds.length > 0) {
        void getProductGroups().then((groups) => {
          if (mounted && groups.length > 0) {
            dispatchBasketAction({ type: 'hydrateGroups', groups });
          }
        }).catch((error: unknown) => {
          console.warn('Não foi possível atualizar os detalhes dos grupos do cabaz.', error);
        });
      }
      if (!appIsActive) flushLatest();
    }).catch((error: unknown) => {
      if (!mounted) return;
      console.warn('Não foi possível ler o cabaz ativo guardado.', error);
      // A failed read must not replace data that may still be present in storage.
      latestLinesRef.current = [];
      isHydratedRef.current = true;
      canPersistRef.current = false;
      for (const action of pendingActionsRef.current.splice(0)) {
        dispatchBasketAction(action);
      }
      setIsHydrated(true);
      setCanPersist(false);
    });

    return () => {
      mounted = false;
      appStateSubscription.remove();
      flushLatest();
    };
  }, [dispatchBasketAction, writer]);

  useEffect(() => {
    if (isHydrated && canPersist) writer.schedule(lines);
  }, [lines, isHydrated, canPersist, writer]);

  const summary = useMemo(() => summarizeBasket(lines), [lines]);
  const addProduct = useCallback((product: string | CatalogProduct) => {
    dispatchBasketAction(
      typeof product === 'string'
        ? { type: 'add', productId: product }
        : { type: 'add', productId: product.id, product },
    );
  }, [dispatchBasketAction]);
  const addProductGroup = useCallback((group: ProductGroupBasketInput) => {
    dispatchBasketAction({ type: 'addGroup', group });
  }, [dispatchBasketAction]);
  const removeProduct = useCallback((productId: string) => {
    dispatchBasketAction({ type: 'remove', productId });
  }, [dispatchBasketAction]);
  const increaseQuantity = useCallback((productId: string) => {
    dispatchBasketAction({ type: 'increase', productId });
  }, [dispatchBasketAction]);
  const decreaseQuantity = useCallback((productId: string) => {
    dispatchBasketAction({ type: 'decrease', productId });
  }, [dispatchBasketAction]);
  const removeProductGroup = useCallback((groupId: string, brand: string | null) => {
    dispatchBasketAction({ type: 'removeGroup', groupId, brand });
  }, [dispatchBasketAction]);
  const increaseProductGroupQuantity = useCallback((groupId: string, brand: string | null) => {
    dispatchBasketAction({ type: 'increaseGroup', groupId, brand });
  }, [dispatchBasketAction]);
  const decreaseProductGroupQuantity = useCallback((groupId: string, brand: string | null) => {
    dispatchBasketAction({ type: 'decreaseGroup', groupId, brand });
  }, [dispatchBasketAction]);
  const replaceBasket = useCallback((basketLines: readonly BasketLine[]) => {
    dispatchBasketAction({ type: 'replace', lines: basketLines });
  }, [dispatchBasketAction]);
  const value = useMemo(
    () => ({
      ...summary,
      isHydrated,
      addProduct,
      addProductGroup,
      removeProduct,
      increaseQuantity,
      decreaseQuantity,
      removeProductGroup,
      increaseProductGroupQuantity,
      decreaseProductGroupQuantity,
      replaceBasket,
    }),
    [
      summary,
      isHydrated,
      addProduct,
      addProductGroup,
      removeProduct,
      increaseQuantity,
      decreaseQuantity,
      removeProductGroup,
      increaseProductGroupQuantity,
      decreaseProductGroupQuantity,
      replaceBasket,
    ],
  );
  return <BasketContext.Provider value={value}>{children}</BasketContext.Provider>;
}

export function useBasket() {
  const basket = useContext(BasketContext);
  if (!basket) throw new Error('useBasket tem de ser usado dentro de BasketProvider');
  return basket;
}