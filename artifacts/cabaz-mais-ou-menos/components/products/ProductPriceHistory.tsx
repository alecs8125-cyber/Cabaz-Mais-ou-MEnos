import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Button, font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { formatDemoPrice } from '@/lib/products';
import type { CatalogProduct } from '@/lib/product-types';
import { getProductPriceHistory } from '@/services/price-history';
import { readQueryRetryDelay, shouldRetryReadQuery } from '@/lib/query-policy';

interface ProductPriceHistoryProps {
  product: CatalogProduct;
  topInset: number;
  bottomInset: number;
  onBack: () => void;
}

export function ProductPriceHistory({
  product,
  topInset,
  bottomInset,
  onBack,
}: ProductPriceHistoryProps) {
  const c = useColors();
  const history = useQuery({
    queryKey: ['product-price-history', product.id],
    queryFn: ({ signal }) => getProductPriceHistory(product.id, signal),
    enabled: !product.isDemo,
    staleTime: 60000,
    gcTime: 60000,
    networkMode: 'always',
    retry: shouldRetryReadQuery,
    retryDelay: readQueryRetryDelay,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  return (
    <View testID="product-detail-sheet" style={[styles.screen, { backgroundColor: c.background }]}>
      <View style={[styles.header, { paddingTop: topInset, borderBottomColor: c.border }]}>
        <Pressable
          testID="product-detail-back"
          accessibilityRole="button"
          accessibilityLabel="Voltar ao catálogo de produtos"
          hitSlop={8}
          onPress={onBack}
          style={({ pressed }) => [styles.back, { opacity: pressed ? 0.65 : 1 }]}
        >
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>
        <Text accessibilityRole="header" style={[styles.productName, { color: c.foreground }]}>
          {product.name}
        </Text>
      </View>

      <ScrollView
        testID="product-price-history"
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.sectionTitle, { color: c.foreground }]}>Histórico de preços</Text>

        {product.isDemo ? (
          <Text testID="product-price-history-empty" style={[styles.message, { color: c.mutedForeground }]}>
            Não existem dados históricos suficientes.
          </Text>
        ) : history.isPending ? (
          <View style={styles.messageBlock} testID="product-price-history-loading">
            <ActivityIndicator color={c.primary} />
            <Text style={[styles.message, { color: c.mutedForeground }]}>A carregar histórico…</Text>
          </View>
        ) : history.error && (!history.data || history.data.length === 0) ? (
          <View style={styles.messageBlock} testID="product-price-history-error">
            <Text style={[styles.message, { color: c.tomato }]}>
              Não foi possível carregar o histórico. Verifica a ligação e tenta novamente.
            </Text>
            <Button
              testID="retry-product-price-history"
              label="Tentar novamente"
              onPress={() => void history.refetch()}
            />
          </View>
        ) : history.data?.length === 0 ? (
          <Text testID="product-price-history-empty" style={[styles.message, { color: c.mutedForeground }]}>
            Não existem dados históricos suficientes.
          </Text>
        ) : (
          <View style={styles.entries}>
            {history.error ? (
              <View testID="product-price-history-cached-warning" style={styles.messageBlock}>
                <Text style={[styles.message, { color: c.tomato }]}>
                  Sem ligação. A mostrar o histórico guardado, atualizado pela última vez em{' '}
                  {new Date(history.dataUpdatedAt).toLocaleString('pt-PT')}.
                </Text>
                <Button
                  testID="retry-product-price-history-cached"
                  label="Tentar novamente"
                  onPress={() => void history.refetch()}
                />
              </View>
            ) : null}
            <Text style={[styles.message, { color: c.mutedForeground }]}>
              Estes valores são históricos e não representam preços atuais.
            </Text>
            {(history.data ?? []).map((entry, index) => (
              <View
                key={`${entry.capturedAt}-${entry.storeName}-${index}`}
                testID={`product-price-history-entry-${index}`}
                style={[styles.entry, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}
              >
                <View style={styles.entryHead}>
                  <Text style={[styles.storeName, { color: c.foreground }]}>{entry.storeName}</Text>
                  <Text style={[styles.price, { color: c.primary }]}>{formatDemoPrice(entry.priceCents)}</Text>
                </View>
                <Text style={[styles.date, { color: c.mutedForeground }]}>
                  Atualizado: {new Date(entry.capturedAt).toLocaleString('pt-PT', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  productName: { flex: 1, fontFamily: font.bold, fontSize: 22, letterSpacing: -0.5 },
  content: { padding: 20, gap: 14 },
  sectionTitle: { fontFamily: font.bold, fontSize: 18 },
  messageBlock: { alignItems: 'center', gap: 12, paddingVertical: 32 },
  message: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  entries: { gap: 10 },
  entry: { borderWidth: 1, padding: 15, gap: 7 },
  entryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  storeName: { flex: 1, minWidth: 0, fontFamily: font.semibold, fontSize: 15 },
  price: { fontFamily: font.bold, fontSize: 18, fontVariant: ['tabular-nums'] },
  date: { fontFamily: font.regular, fontSize: 13 },
});