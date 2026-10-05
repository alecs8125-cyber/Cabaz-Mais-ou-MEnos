import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Button, EmptyState, ScreenTitle, font } from '@/components/ui';
import { DemoPriceBadge } from '@/components/products/DemoPriceBadge';
import { ComparisonDetailModal } from '@/components/comparison/ComparisonDetailModal';
import { StoreResultCard } from '@/components/comparison/StoreResultCard';
import { useColors } from '@/hooks/useColors';
import { useBasket } from '@/context/BasketContext';
import { useZone } from '@/context/ZoneContext';
import type { ProductGroupBasketItem } from '@/lib/basket';
import { resolveLocation } from '@/lib/locations';
import { isExactBasketItem } from '@/lib/basket';
import {
  collectComparisonProductIds,
  compareSupabaseBasket,
  compareSupabaseBasketWithGroups,
  formatBasketCoverage,
  hasProductGroupBasketItems,
  type ProductGroupMembersById,
  type StoreComparison,
} from '@/lib/comparison';
import { getProductGroupMembers } from '@/services/product-groups';
import { getComparisonData } from '@/services/prices';
import { readQueryRetryDelay, shouldRetryReadQuery } from '@/lib/query-policy';

const EMPTY_GROUP_MEMBERS: ProductGroupMembersById = {};

export default function CompararScreen() {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <CompararContent />
    </QueryClientProvider>
  );
}

function CompararContent() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? 67 : insets.top;
  const { items } = useBasket();
  const { location, isLoading: isLocationLoading } = useZone();
  const [selectedResult, setSelectedResult] = useState<StoreComparison | null>(null);
  const [comparisonNow, setComparisonNow] = useState(() => Date.now());
  const isEmpty = items.length === 0;
  const groupItems = useMemo(
    () => items.filter((item): item is ProductGroupBasketItem => item.kind === 'group'),
    [items],
  );
  const hasGroupChoices = hasProductGroupBasketItems(items);
  const exactItems = useMemo(() => items.filter(isExactBasketItem), [items]);
  useEffect(() => {
    if (hasGroupChoices) setSelectedResult(null);
  }, [hasGroupChoices]);
  const comparisonLocation = useMemo(() => {
    const resolved = resolveLocation(location);
    return resolved
      ? {
          district: resolved.district.name,
          municipality: resolved.municipality.name,
          parish: resolved.parish.name,
        }
      : null;
  }, [location]);
  const groupIds = useMemo(
    () => [...new Set(groupItems.map((item) => item.groupId))].sort(),
    [groupItems],
  );
  const groupMembersQuery = useQuery({
    queryKey: ['comparison-product-group-members', groupIds],
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(groupIds.map(async (groupId) =>
        [groupId, await getProductGroupMembers(groupId, signal)] as const));
      return Object.fromEntries(entries) as ProductGroupMembersById;
    },
    enabled: groupIds.length > 0,
    staleTime: 60000,
    gcTime: 60000,
    networkMode: 'always',
    retry: shouldRetryReadQuery,
    retryDelay: readQueryRetryDelay,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
  const groupMembersById = groupMembersQuery.data ?? EMPTY_GROUP_MEMBERS;
  const productIds = useMemo(
    () => collectComparisonProductIds(items, groupMembersById),
    [groupMembersById, items],
  );
  const basketIds = useMemo(
    () => items.map((item) => item.kind === 'group'
      ? `group:${JSON.stringify([item.groupId, item.brand])}`
      : item.product.id).sort(),
    [items],
  );
  const pricesQuery = useQuery({
    queryKey: [
      'supabase-comparison',
      basketIds,
      ...(hasGroupChoices ? [productIds] : []),
      location?.districtId ?? null,
      location?.municipalityId ?? null,
      location?.parishId ?? null,
    ],
    queryFn: ({ signal }) => getComparisonData(productIds, comparisonLocation, signal),
    enabled: !isEmpty && !isLocationLoading &&
      (!hasGroupChoices || groupMembersQuery.data !== undefined),
    staleTime: 0,
    gcTime: 60000,
    networkMode: 'always',
    retry: shouldRetryReadQuery,
    retryDelay: readQueryRetryDelay,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current && !isEmpty) {
      if (hasGroupChoices) void groupMembersQuery.refetch();
      void pricesQuery.refetch();
    }
    focusedOnce.current = true;
  }, [groupMembersQuery.refetch, hasGroupChoices, isEmpty, pricesQuery.refetch]));
  const nextPriceExpiry = useMemo(() => {
    let earliest: number | null = null;
    for (const price of pricesQuery.data?.prices ?? []) {
      if (!price.validUntil) continue;
      const validUntil = Date.parse(price.validUntil);
      if (Number.isFinite(validUntil) && (earliest === null || validUntil < earliest)) {
        earliest = validUntil;
      }
    }
    return earliest;
  }, [pricesQuery.data?.prices]);
  useEffect(() => {
    if (nextPriceExpiry === null) return;
    const delay = Math.max(0, nextPriceExpiry - Date.now() + 1);
    const timer = setTimeout(() => {
      const now = Date.now();
      setComparisonNow(now);
      if (now > nextPriceExpiry) void pricesQuery.refetch();
    }, Math.min(delay, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [nextPriceExpiry, pricesQuery.refetch]);
  const nowForComparison = Math.max(comparisonNow, Date.now());
  const results = useMemo(
    () => {
      if (!pricesQuery.data) return [];
      return hasGroupChoices
        ? compareSupabaseBasketWithGroups(
            items,
            pricesQuery.data.stores,
            pricesQuery.data.prices,
            groupMembersById,
            nowForComparison,
          )
        : compareSupabaseBasket(
            exactItems,
            pricesQuery.data.stores,
            pricesQuery.data.prices,
            nowForComparison,
          );
    },
    [exactItems, groupMembersById, hasGroupChoices, items, nowForComparison, pricesQuery.data],
  );
  const loading = isLocationLoading ||
    (hasGroupChoices && groupMembersQuery.isFetching) ||
    ((!hasGroupChoices || groupMembersQuery.data !== undefined) &&
      (pricesQuery.isPending || pricesQuery.isFetching));
  const visibleSelectedResult =
    loading || pricesQuery.error || groupMembersQuery.error || !selectedResult
      ? null
      : results.find((result) => result.storeId === selectedResult.storeId) ?? null;

  return (
    <>
    <ScrollView
      testID="screen-comparar"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.content, { paddingTop: top + 24, paddingBottom: insets.bottom + 120 }]}
      showsVerticalScrollIndicator={false}
    >
      <ScreenTitle kicker="Supermercados" title="Comparação" />
      <DemoPriceBadge
        label="Preços do Supabase"
        detail="Apenas preços verificados e em vigor. Os registos identificados como demonstração são fictícios."
      />

      {isEmpty ? (
        <EmptyState
          icon="bar-chart-2"
          eyebrow="Cabaz vazio"
          title="Nada para comparar, por agora"
          body="Adiciona produtos ao teu cabaz para ver quanto custaria em cada loja."
          note="Os preços de demonstração no Supabase não correspondem a preços de mercado."
        />
      ) : (
        <View testID="comparison-results" style={styles.results}>
          <View style={styles.intro}>
            <Text style={[styles.sorted, { color: c.primary }]}>
              {hasGroupChoices
                ? 'CABAZES COMPLETOS PRIMEIRO · DEPOIS MENOR TOTAL'
                : 'ORDENADO PELO TOTAL MAIS BAIXO'}
            </Text>
            <Text style={[styles.info, { color: c.mutedForeground }]}>
              {hasGroupChoices
                ? 'Cada escolha conta como uma linha. O SKU mais barato com preço válido é escolhido por loja; linhas em falta não entram no total parcial.'
                : 'Os totais multiplicam as quantidades pedidas; as contagens de produtos referem-se a tipos de produto distintos. Totais parciais excluem produtos em falta e não podem ser comparados como ofertas de cabaz completo.'}
            </Text>
          </View>
          {loading ? (
            <View style={styles.feedback} testID="comparison-loading">
              <ActivityIndicator color={c.primary} />
              <Text style={[styles.info, { color: c.mutedForeground }]}>
                {hasGroupChoices
                  ? 'A carregar produtos dos grupos e preços verificados…'
                  : 'A carregar preços do Supabase…'}
              </Text>
            </View>
          ) : hasGroupChoices && groupMembersQuery.error ? (
            <View style={styles.feedback} testID="comparison-group-error">
              <EmptyState
                icon="alert-circle"
                eyebrow="Erro de ligação"
                title="Não foi possível carregar os produtos dos grupos"
                body={groupMembersQuery.error instanceof Error
                  ? groupMembersQuery.error.message
                  : 'O serviço de grupos devolveu um erro inesperado.'}
                note="A comparação foi interrompida; não foram tratados grupos como produtos exatos."
              />
              <Button
                testID="comparison-group-retry"
                label="Tentar novamente"
                onPress={() => void groupMembersQuery.refetch()}
              />
            </View>
          ) : pricesQuery.error ? (
            <View style={styles.feedback} testID="comparison-error">
              <EmptyState
                icon="alert-circle"
                eyebrow="Erro de ligação"
                title="Não foi possível comparar os preços"
                body={pricesQuery.error instanceof Error
                  ? pricesQuery.error.message
                  : 'O serviço de preços devolveu um erro inesperado.'}
                note="Preços guardados não são mostrados como atuais. Volta a tentar quando a ligação estiver disponível."
              />
              <Button testID="comparison-retry" label="Tentar novamente" onPress={() => void pricesQuery.refetch()} />
            </View>
          ) : results.length === 0 ? (
            <EmptyState
              icon="shopping-bag"
              eyebrow="Sem lojas"
              title="Não há lojas para comparar"
              body="Não foi encontrada nenhuma loja ativa no Supabase."
              note="Volta a tentar mais tarde."
            />
           ) : results.map((r, i) => (
            <StoreResultCard key={r.storeId} result={r} rank={i + 1} onPress={() => setSelectedResult(r)} />
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <Button
          testID="button-ir-cabaz"
          label="Ir para o meu cabaz"
          icon="shopping-bag"
          onPress={() => router.navigate('/cabaz')}
        />
        <Button
          testID="button-voltar-inicio"
          variant="ghost"
          label="Voltar ao início"
          onPress={() => router.navigate('/')}
        />
      </View>
    </ScrollView>
    <ComparisonDetailModal
      result={visibleSelectedResult}
      onClose={() => setSelectedResult(null)}
    />
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: 20, maxWidth: 560, width: '100%', alignSelf: 'center' },
  results: { gap: 12 },
  feedback: { gap: 12, alignItems: 'center' },
  intro: { gap: 6, marginBottom: 4 },
  sorted: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.2 },
  info: { fontFamily: font.regular, fontSize: 13, lineHeight: 19 },
  actions: { gap: 6 },
});
