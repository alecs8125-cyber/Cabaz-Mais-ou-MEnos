import React, { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react';
import {
  basketReducer,
  summarizeBasket,
  type BasketItem,
  type BasketLine,
  type ProductGroupBasketInput,
} from '@/lib/basket';
import type { CatalogProduct } from '@/lib/product-types';

interface BasketContextValue {
  items: readonly BasketItem[];
  totalCents: number | null;
  totalQuantity: number;
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

// Cabaz em memória durante esta sessão, independente da zona guardada no dispositivo.
export function BasketProvider({ children }: { children: ReactNode }) {
  const [lines, dispatch] = useReducer(basketReducer, []);
  const summary = useMemo(() => summarizeBasket(lines), [lines]);
  const addProduct = useCallback((product: string | CatalogProduct) => dispatch(
    typeof product === 'string'
      ? { type: 'add', productId: product }
      : { type: 'add', productId: product.id, product },
  ), []);
  const addProductGroup = useCallback((group: ProductGroupBasketInput) =>
    dispatch({ type: 'addGroup', group }), []);
  const removeProduct = useCallback((productId: string) => dispatch({ type: 'remove', productId }), []);
  const increaseQuantity = useCallback((productId: string) => dispatch({ type: 'increase', productId }), []);
  const decreaseQuantity = useCallback((productId: string) => dispatch({ type: 'decrease', productId }), []);
  const removeProductGroup = useCallback((groupId: string, brand: string | null) =>
    dispatch({ type: 'removeGroup', groupId, brand }), []);
  const increaseProductGroupQuantity = useCallback((groupId: string, brand: string | null) =>
    dispatch({ type: 'increaseGroup', groupId, brand }), []);
  const decreaseProductGroupQuantity = useCallback((groupId: string, brand: string | null) =>
    dispatch({ type: 'decreaseGroup', groupId, brand }), []);
  const replaceBasket = useCallback((basketLines: readonly BasketLine[]) =>
    dispatch({ type: 'replace', lines: basketLines }), []);
  const value = useMemo(
    () => ({
      ...summary,
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