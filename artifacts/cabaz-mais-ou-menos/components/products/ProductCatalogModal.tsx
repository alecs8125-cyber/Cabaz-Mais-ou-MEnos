import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Feather } from '@expo/vector-icons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useBasket } from '@/context/BasketContext';
import { useProductCatalog } from '@/hooks/useProductCatalog';
import { formatDemoPrice, searchProducts } from '@/lib/products';
import type { CatalogProduct } from '@/lib/product-types';
import { DemoPriceBadge } from './DemoPriceBadge';
import { ProductPriceHistory } from './ProductPriceHistory';

interface CatalogProps { visible: boolean; onClose: () => void }

export function ProductCatalogModal(props: CatalogProps) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <ProductCatalogContent {...props} />
    </QueryClientProvider>
  );
}

function ProductCatalogContent({ visible, onClose }: CatalogProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { items, addProduct } = useBasket();
  const [query, setQuery] = useState<string>('');
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const catalog = useProductCatalog(visible, query);
  // A lista local só aparece quando a leitura remota falha, nunca quando o resultado é vazio.
  const results: readonly CatalogProduct[] = catalog.loading
    ? []
    : catalog.error ? searchProducts(query) : catalog.products;
  const qtyById = useMemo(() => {
    const m: Record<string, number> = {};
    items.forEach((i) => {
      if (i.kind !== 'group') m[i.product.id] = i.quantity;
    });
    return m;
  }, [items]);
  const isWeb = Platform.OS === 'web';
  const top = isWeb ? 67 : Platform.OS === 'ios' ? 12 : insets.top + 8;
  const bottom = isWeb ? 34 : insets.bottom;

  const handleAdd = (p: CatalogProduct) => {
    addProduct(p);
    setLastAdded(p.name);
  };

  const handleClose = () => {
    setQuery('');
    setLastAdded(null);
    setSelectedProduct(null);
    onClose();
  };

  const renderItem = ({ item: p }: { item: CatalogProduct }) => {
    const q = qtyById[p.id] ?? 0;
    return (
      <View style={[styles.product, { borderColor: c.border }]}>
        <Pressable
          testID={`view-product-${p.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Ver detalhe e histórico de preços de ${p.name}`}
          onPress={() => {
            setLastAdded(null);
            setSelectedProduct(p);
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Text style={[styles.category, { color: c.tomato }]}>{p.category || 'Sem categoria'}</Text>
          <Text style={[styles.pName, { color: c.foreground }]} numberOfLines={2}>{p.name}</Text>
          <Text style={[styles.pMeta, { color: c.mutedForeground }]}>
            {p.isDemo ? `${p.brand} (fictícia) · ${p.unit}` : [p.brand, p.unit].filter(Boolean).join(' · ')}
          </Text>
          <Text style={[styles.pPrice, { color: c.primary }]}>
            {p.isDemo ? formatDemoPrice(p.demoPriceCents) : 'Preço indisponível'}
          </Text>
        </Pressable>
        <Pressable
          testID={`add-product-${p.id}`}
          accessibilityRole="button"
          accessibilityLabel={q > 0 ? `Adicionar mais um ${p.name}. Já tens ${q}` : `Adicionar ${p.name} ao cabaz`}
          onPress={() => handleAdd(p)}
          style={({ pressed }) => [
            styles.add,
            { backgroundColor: q > 0 ? c.leafSoft : c.primary, borderRadius: c.radius - 6, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Feather name="plus" size={16} color={q > 0 ? c.primary : c.primaryForeground} />
          <Text style={[styles.addText, { color: q > 0 ? c.primary : c.primaryForeground }]}>
            {q > 0 ? `${q} no cabaz` : 'Adicionar'}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
        {selectedProduct ? (
          <ProductPriceHistory
            product={selectedProduct}
            topInset={top}
            bottomInset={bottom}
            onBack={() => setSelectedProduct(null)}
          />
        ) : (
          <>
        <View style={[styles.header, { paddingTop: top }]}>
          <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={[styles.title, { color: c.foreground }]}>Adicionar produto</Text>
            <Pressable
              testID="close-product-catalog"
              accessibilityRole="button"
              accessibilityLabel="Fechar lista de produtos"
              hitSlop={8}
              onPress={handleClose}
              style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Feather name="x" size={24} color={c.foreground} />
            </Pressable>
          </View>
          <DemoPriceBadge
            label={catalog.error ? undefined : 'Catálogo de produtos'}
            detail={catalog.error
              ? 'Produtos, marcas e preços fictícios, só para experimentar.'
              : 'Preços ainda não disponíveis para estes produtos.'}
          />
          <View style={[styles.search, { backgroundColor: c.card, borderColor: c.input, borderRadius: c.radius - 4 }]}>
            <Feather name="search" size={18} color={c.mutedForeground} />
            <TextInput
              testID="product-search"
              value={query}
              onChangeText={setQuery}
              placeholder="Procurar por nome"
              placeholderTextColor={c.mutedForeground}
              accessibilityLabel="Procurar produto por nome"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={[styles.input, { color: c.foreground }]}
            />
            {query ? (
              <Pressable
                testID="clear-product-search"
                accessibilityRole="button"
                accessibilityLabel="Limpar pesquisa"
                style={styles.clearSearch}
                onPress={() => setQuery('')}
              >
                <Feather name="x-circle" size={18} color={c.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <FlatList
          testID="product-catalog-list"
          data={results}
          extraData={qtyById}
          keyExtractor={(p) => p.id}
          renderItem={renderItem}
          onEndReached={() => {
            if (!catalog.loading && !catalog.error && catalog.hasMore && !catalog.nextPageError) {
              catalog.loadMore();
            }
          }}
          onEndReachedThreshold={0.5}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEnabled={results.length > 0}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          ListHeaderComponent={catalog.error ? (
            <View style={styles.empty} accessibilityLiveRegion="polite">
              <Feather name="alert-circle" size={28} color={c.tomato} />
              <Text testID="product-search-error" style={[styles.emptyTitle, { color: c.foreground }]}>
                Não foi possível carregar os produtos. Tenta novamente.
              </Text>
              <Pressable
                testID="retry-product-search"
                accessibilityRole="button"
                onPress={catalog.retry}
                style={({ pressed }) => [
                  styles.add, { backgroundColor: c.primary, borderRadius: c.radius - 6, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={[styles.addText, { color: c.primaryForeground }]}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : null}
          ListEmptyComponent={
            <View style={styles.empty} accessibilityLiveRegion="polite">
              {catalog.loading ? (
                <>
                  <ActivityIndicator testID="product-search-loading" size="large" color={c.primary} />
                  <Text style={[styles.emptyTitle, { color: c.foreground }]}>A carregar produtos…</Text>
                </>
              ) : catalog.error ? (
                <Text style={[styles.emptyBody, { color: c.mutedForeground }]}>Sem produtos de demonstração para esta pesquisa.</Text>
              ) : (
                <>
                  <Feather name="search" size={28} color={c.primary} />
                  <Text testID="product-search-empty" style={[styles.emptyTitle, { color: c.foreground }]}>
                    {query.trim() ? `Sem resultados para "${query.trim()}"` : 'Sem produtos disponíveis'}
                  </Text>
                  <Text style={[styles.emptyBody, { color: c.mutedForeground }]}>
                    {query.trim() ? 'Experimenta outro nome.' : 'Não há produtos ativos disponíveis neste momento.'}
                  </Text>
                </>
              )}
            </View>
          }
          ListFooterComponent={
            !catalog.loading && !catalog.error && (catalog.loadingMore || catalog.nextPageError) ? (
              <View style={styles.more}>
                {catalog.loadingMore ? <ActivityIndicator color={c.primary} /> : (
                  <>
                    {catalog.nextPageError ? (
                      <Text style={[styles.emptyBody, { color: c.mutedForeground }]}>
                        Não foi possível carregar os produtos. Tenta novamente.
                      </Text>
                    ) : null}
                    <Pressable
                      testID="load-more-products"
                      accessibilityRole="button"
                      onPress={catalog.loadMore}
                      style={({ pressed }) => [
                        styles.add, { backgroundColor: c.primary, borderRadius: c.radius - 6, opacity: pressed ? 0.8 : 1 },
                      ]}
                    >
                      <Text style={[styles.addText, { color: c.primaryForeground }]}>Tentar novamente</Text>
                    </Pressable>
                  </>
                )}
              </View>
            ) : null
          }
        />
          </>
        )}
        {!selectedProduct ? (
          lastAdded ? (
            <View
              accessibilityLiveRegion="polite"
              style={[styles.toast, { backgroundColor: c.primary, marginBottom: bottom + 12, borderRadius: c.radius - 4 }]}
            >
              <Feather name="check" size={18} color={c.accent} />
              <Text style={[styles.toastText, { color: c.primaryForeground }]} numberOfLines={2}>
                {lastAdded} adicionado ao cabaz
              </Text>
            </View>
          ) : <View style={{ height: bottom }} />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, gap: 12, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.6, flexShrink: 1 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, paddingHorizontal: 14, minHeight: 50 },
  input: { flex: 1, minWidth: 0, fontFamily: font.medium, fontSize: 16, paddingVertical: 12 },
  clearSearch: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  more: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  product: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, borderBottomWidth: 1 },
  category: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  pName: { fontFamily: font.semibold, fontSize: 16, marginTop: 2 },
  pMeta: { fontFamily: font.regular, fontSize: 13, marginTop: 1 },
  pPrice: { fontFamily: font.bold, fontSize: 15, marginTop: 4 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12 },
  addText: { fontFamily: font.semibold, fontSize: 13 },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 8, paddingHorizontal: 12 },
  emptyTitle: { fontFamily: font.bold, fontSize: 17, textAlign: 'center' },
  emptyBody: { fontFamily: font.regular, fontSize: 14, textAlign: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 20, padding: 14 },
  toastText: { flex: 1, fontFamily: font.semibold, fontSize: 14 },
});
