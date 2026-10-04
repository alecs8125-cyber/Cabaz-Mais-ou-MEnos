import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProductCategories, getProducts } from '@/services/products';

const PRODUCTS_KEY = ['supabase-product-search'] as const;

export function useProductCatalog(visible: boolean, query: string) {
  const client = useQueryClient();
  const name = query.trim().replace(/\s+/g, ' ');
  const [debouncedName, setDebouncedName] = useState(name);
  const isDebouncing = name !== debouncedName;

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedName(name), 300);
    return () => clearTimeout(timeout);
  }, [name]);

  useEffect(() => {
    if (!visible) {
      void client.cancelQueries({ queryKey: PRODUCTS_KEY });
      // Ao reabrir, pedir a primeira página atual, sem refazer páginas antigas.
      client.removeQueries({ queryKey: PRODUCTS_KEY });
    }
  }, [client, visible]);

  const productsQuery = useInfiniteQuery({
    queryKey: [...PRODUCTS_KEY, debouncedName],
    queryFn: ({ pageParam, signal }) => getProducts({
      query: debouncedName,
      offset: pageParam,
      signal,
    }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: visible && !isDebouncing,
    staleTime: 0,
    gcTime: 60000,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: false,
  });

  const error = productsQuery.isFetchNextPageError ? null : productsQuery.error;
  const loading = isDebouncing || productsQuery.isPending || productsQuery.isRefetching;

  return {
    products: loading || error ? [] : productsQuery.data?.pages.flatMap((page) => page.products) ?? [],
    loading,
    error,
    retry: () => {
      void productsQuery.refetch();
    },
    hasMore: productsQuery.hasNextPage,
    loadingMore: productsQuery.isFetchingNextPage,
    nextPageError: productsQuery.isFetchNextPageError ? productsQuery.error : null,
    loadMore: () => {
      if (!isDebouncing && !productsQuery.isFetching && productsQuery.hasNextPage) {
        void productsQuery.fetchNextPage();
      }
    },
  };
}