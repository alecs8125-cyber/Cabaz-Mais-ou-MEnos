import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProductCategories, getProducts } from '@/services/products';
import { readQueryRetryDelay, shouldRetryReadQuery } from '@/lib/query-policy';

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
      // Keep the last successful page for offline browsing when the catalog reopens.
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
    gcTime: 5 * 60 * 1000,
    networkMode: 'always',
    retry: shouldRetryReadQuery,
    retryDelay: readQueryRetryDelay,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  const error = productsQuery.isFetchNextPageError ? null : productsQuery.error;
  const hasCachedData = productsQuery.data !== undefined;
  const loading = isDebouncing || (!hasCachedData && (productsQuery.isPending || productsQuery.isFetching));

  return {
    products: isDebouncing ? [] : productsQuery.data?.pages.flatMap((page) => page.products) ?? [],
    loading,
    error,
    hasCachedData,
    usingDemoFallback: Boolean(error && !hasCachedData),
    dataUpdatedAt: productsQuery.dataUpdatedAt,
    showingCachedData: hasCachedData && (Boolean(error) || productsQuery.isFetching),
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