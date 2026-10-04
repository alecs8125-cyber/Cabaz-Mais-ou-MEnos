import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { font } from '@/components/ui';
import { useZone } from '@/context/ZoneContext';
import { useBasket } from '@/context/BasketContext';
import { useColors } from '@/hooks/useColors';
import {
  createProductGroupSelection,
  formatProductGroupPackage,
  getGroupsForVariant,
  getProductGroupBrandOptions,
  getProductTypes,
  getProductVariants,
} from '@/lib/product-group-options';
import { getProductCategories, getProducts } from '@/services/products';
import { getProductGroupMembers, getProductGroups } from '@/services/product-groups';
import { mergeUniqueProductPages } from '@/lib/product-pages';
import type { CatalogProduct } from '@/lib/product-types';

const PRODUCTS_KEY = ['home-products'] as const;
const CATEGORIES_KEY = ['home-product-categories'] as const;
const PRODUCT_GROUPS_KEY = ['home-product-groups'] as const;
const PRODUCT_GROUP_MEMBERS_KEY = ['home-product-group-members'] as const;

function categoryIcon(category: string): keyof typeof Feather.glyphMap {
  const name = category.toLocaleLowerCase('pt-PT');
  if (/frut|hort|verd/.test(name)) return 'sun';
  if (/legum/.test(name)) return 'grid';
  if (/leite|latic|derivad/.test(name)) return 'droplet';
  if (/bebid|água|agua/.test(name)) return 'coffee';
  if (/carne|peixe/.test(name)) return 'shopping-bag';
  return 'package';
}

export default function HomeScreen() {
  const [client] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={client}>
      <HomeContent />
    </QueryClientProvider>
  );
}

function HomeContent() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { zone, isLoading, restoreError } = useZone();
  const { items, totalQuantity, addProduct, addProductGroup } = useBasket();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [selectedProductType, setSelectedProductType] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupSelection, setGroupSelection] = useState<ReturnType<typeof createProductGroupSelection> | null>(null);
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const [debouncedQuery, setDebouncedQuery] = useState(normalizedQuery);
  const isDebouncing = normalizedQuery !== debouncedQuery;
  const productGroupsQuery = useQuery({
    queryKey: PRODUCT_GROUPS_KEY,
    queryFn: ({ signal }) => getProductGroups(signal),
    staleTime: 60000,
    retry: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
  });
  const productGroupMembersQuery = useQuery({
    queryKey: [...PRODUCT_GROUP_MEMBERS_KEY, selectedGroupId],
    queryFn: ({ signal }) => {
      if (!selectedGroupId) throw new Error('O grupo selecionado é inválido.');
      return getProductGroupMembers(selectedGroupId, signal);
    },
    enabled: selectedGroupId !== null,
    staleTime: 60000,
    retry: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
  });
  const categoriesQuery = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: ({ signal }) => getProductCategories(signal),
    staleTime: 60000,
    retry: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
  });
  const productsQuery = useInfiniteQuery({
    queryKey: [...PRODUCTS_KEY, debouncedQuery, category],
    queryFn: ({ pageParam, signal }) => getProducts({
      query: debouncedQuery,
      category,
      offset: pageParam,
      signal,
    }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !isDebouncing,
    staleTime: 0,
    gcTime: 60000,
    retry: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
  });
  const productGroups = productGroupsQuery.data ?? [];
  const productTypes = useMemo(() => getProductTypes(productGroups), [productGroups]);
  const variants = useMemo(
    () => selectedProductType ? getProductVariants(productGroups, selectedProductType) : [],
    [productGroups, selectedProductType],
  );
  const packageGroups = useMemo(
    () => selectedProductType && selectedVariant
      ? getGroupsForVariant(productGroups, selectedProductType, selectedVariant)
      : [],
    [productGroups, selectedProductType, selectedVariant],
  );
  const selectedProductGroup = productGroups.find((group) => group.id === selectedGroupId) ?? null;
  const productGroupMembers = productGroupMembersQuery.data ?? [];
  const brandOptions = useMemo(
    () => getProductGroupBrandOptions(productGroupMembers),
    [productGroupMembers],
  );
  const hasValidGroupBrands = brandOptions.length > 1;
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(normalizedQuery), 300);
    return () => clearTimeout(timeout);
  }, [normalizedQuery]);
  const productsError = productsQuery.isFetchNextPageError ? null : productsQuery.error;
  const productsLoading = isDebouncing || productsQuery.isPending || productsQuery.isRefetching;
  const productsFromServer = useMemo(
    () => productsLoading || productsError
      ? []
      : mergeUniqueProductPages(productsQuery.data?.pages ?? []),
    [productsError, productsLoading, productsQuery.data],
  );
  const quantities = useMemo(() => {
    const result: Record<string, number> = {};
    items.forEach((item) => {
      if (item.kind !== 'group') result[item.product.id] = item.quantity;
    });
    return result;
  }, [items]);
  const top = Platform.OS === 'web' ? 67 : insets.top;
  const bottom = Platform.OS === 'web' ? 34 : insets.bottom;

  const handleAdd = (product: CatalogProduct) => {
    addProduct(product);
    setLastAdded(product.name);
    setTimeout(() => setLastAdded(null), 2200);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.screen, { backgroundColor: c.background }]}>
      <ScrollView
        testID="screen-inicio"
        style={{ backgroundColor: c.background }}
        contentContainerStyle={[styles.content, { paddingTop: top + 14, paddingBottom: bottom + 112 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={Keyboard.dismiss}
        scrollEventThrottle={16}
      >
        <View style={styles.topBar}>
          <View style={styles.brandGroup}>
            <Image
              source={require('../../assets/images/cabaz-mais-ou-menos-logo.png')}
              resizeMode="contain"
              style={styles.brandMark}
              accessible={false}
            />
            <View>
              <Text accessibilityRole="header" style={[styles.brand, { color: c.foreground }]}>Cabaz</Text>
              <Text style={[styles.brandAccent, { color: c.primary }]}>
                Mais ou <Text style={{ color: c.accent }}>Menos</Text>
              </Text>
            </View>
          </View>
          <Pressable
            testID="button-cabaz-header"
            accessibilityRole="button"
            accessibilityLabel="Abrir o meu cabaz"
            onPress={() => router.navigate('/cabaz')}
            style={({ pressed }) => [styles.basketButton, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="shopping-bag" size={18} color={c.primary} />
            {totalQuantity > 0 ? (
              <View style={[styles.quantityDot, { backgroundColor: c.accent }]}>
                <Text style={[styles.quantityText, { color: c.card }]}>{totalQuantity > 9 ? '9+' : totalQuantity}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        <Text style={[styles.slogan, { color: c.mutedForeground }]}>
          Descobre onde o teu cabaz fica mais barato.
        </Text>

        <View style={[styles.search, { backgroundColor: c.card, borderColor: c.input }]}>
          <Feather name="search" size={19} color={c.mutedForeground} />
          <TextInput
            testID="home-product-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Pesquisar produtos..."
            placeholderTextColor={c.mutedForeground}
            accessibilityLabel="Pesquisar produtos"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, { color: c.foreground }]}
          />
          {query.length > 0 ? (
            <Pressable
              testID="clear-home-search"
              accessibilityRole="button"
              accessibilityLabel="Limpar pesquisa"
              onPress={() => setQuery('')}
              hitSlop={8}
            >
              <Feather name="x-circle" size={18} color={c.mutedForeground} />
            </Pressable>
          ) : null}
        </View>

        <Pressable
          testID="button-zona-atual"
          accessibilityRole="button"
          accessibilityLabel={zone ? `Zona ${zone}. Alterar zona` : 'Escolher zona manualmente'}
          accessibilityState={{ disabled: isLoading }}
          disabled={isLoading}
          onPress={() => router.push({ pathname: '/escolher-zona', params: { returnTo: 'home' } })}
          style={({ pressed }) => [
            styles.zoneCard,
            { backgroundColor: c.card, borderColor: c.border, opacity: pressed || isLoading ? 0.72 : 1 },
          ]}
        >
          <View style={[styles.zoneIcon, { backgroundColor: c.leafSoft }]}>
            <Feather name="map-pin" size={17} color={c.primary} />
          </View>
          <View style={styles.zoneCopy}>
            <Text style={[styles.zoneLabel, { color: c.mutedForeground }]}>A comparar na tua zona</Text>
            <Text testID="home-zone-name" style={[styles.zoneValue, { color: c.foreground }]}>
              {isLoading ? 'A carregar zona...' : zone ?? 'Escolhe uma zona manualmente'}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={c.mutedForeground} />
        </Pressable>
        {restoreError ? (
          <Text accessibilityRole="alert" style={[styles.zoneError, { color: c.tomato }]}>{restoreError}</Text>
        ) : null}

        <View style={styles.section}>
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={[styles.sectionTitle, { color: c.foreground }]}>Explorar produtos</Text>
            <Text style={[styles.sectionHint, { color: c.mutedForeground }]}>Catálogo real</Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categoryList}
            keyboardShouldPersistTaps="handled"
          >
            {categoriesQuery.isPending ? (
              [0, 1, 2, 3].map((item) => <View key={item} style={[styles.categorySkeleton, { backgroundColor: c.muted }]} />)
            ) : (
              [
                { label: 'Todos', value: null, icon: 'grid' as const },
                ...(categoriesQuery.data ?? []).map((name) => ({
                  label: name,
                  value: name,
                  icon: categoryIcon(name),
                })),
              ].map((item) => {
              const active = category === item.value;
              return (
                <Pressable
                  key={item.value ?? 'all'}
                  testID={`category-${item.value ?? 'all'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Filtrar por ${item.label}`}
                  onPress={() => setCategory(item.value)}
                  style={({ pressed }) => [
                    styles.categoryChip,
                    {
                      backgroundColor: active ? c.primary : c.card,
                      borderColor: active ? c.primary : c.border,
                      opacity: pressed ? 0.76 : 1,
                    },
                  ]}
                >
                    <View style={[styles.categoryIcon, { backgroundColor: active ? c.secondary : c.leafSoft }]}>
                    <Feather name={item.icon} size={16} color={active ? c.primaryForeground : c.primary} />
                  </View>
                  <Text style={[styles.categoryLabel, { color: active ? c.primaryForeground : c.foreground }]}>{item.label}</Text>
                </Pressable>
              );
              })
            )}
          </ScrollView>
          {categoriesQuery.error ? (
            <View style={styles.categoryError}>
              <Text style={[styles.categoryErrorText, { color: c.mutedForeground }]}>Não foi possível carregar as categorias.</Text>
              <Pressable
                testID="retry-home-categories"
                accessibilityRole="button"
                onPress={() => { void categoriesQuery.refetch(); }}
              >
                <Text style={[styles.retryText, { color: c.primary }]}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.section} testID="home-product-groups">
          <View style={styles.sectionHeading}>
            <View>
              <Text accessibilityRole="header" style={[styles.sectionTitle, { color: c.foreground }]}>
                Escolhe o que precisas
              </Text>
              <Text style={[styles.sectionSubline, { color: c.mutedForeground }]}>
                Encontra produtos por tipo, variante e formato
              </Text>
            </View>
          </View>

          <View style={[styles.productsCard, { backgroundColor: c.card, borderColor: c.border }]}>
            {productGroupsQuery.isPending && !productGroupsQuery.data ? (
              <View testID="home-product-groups-loading" style={styles.groupLoading}>
                <ActivityIndicator size="small" color={c.primary} />
                <Text style={[styles.stateBody, { color: c.mutedForeground }]}>
                  A carregar grupos...
                </Text>
              </View>
            ) : productGroupsQuery.error && !productGroupsQuery.data ? (
              <View style={styles.state}>
                <Text
                  testID="home-product-groups-error"
                  accessibilityRole="alert"
                  style={[styles.stateTitle, { color: c.foreground }]}
                >
                  Não foi possível carregar os grupos.
                </Text>
                <Pressable
                  testID="retry-home-product-groups"
                  accessibilityRole="button"
                  onPress={() => { void productGroupsQuery.refetch(); }}
                  style={({ pressed }) => [
                    styles.retry,
                    { borderColor: c.primary, opacity: pressed ? 0.72 : 1 },
                  ]}
                >
                  <Text style={[styles.retryText, { color: c.primary }]}>Tentar novamente</Text>
                </Pressable>
              </View>
            ) : productGroups.length === 0 ? (
              <View style={styles.state}>
                <Text
                  testID="home-product-groups-empty"
                  style={[styles.stateTitle, { color: c.foreground }]}
                >
                  Ainda não há grupos disponíveis.
                </Text>
              </View>
            ) : (
              <View style={styles.groupSelectorContent}>
                <View style={styles.groupStep}>
                  <Text style={[styles.groupStepLabel, { color: c.mutedForeground }]}>Tipo de produto</Text>
                  <View style={styles.groupOptionList}>
                    {productTypes.map((type) => {
                      const active = selectedProductType === type;
                      return (
                        <Pressable
                          key={type}
                          testID={`product-group-type-${type}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => {
                            setSelectedProductType(type);
                            setSelectedVariant(null);
                            setSelectedGroupId(null);
                            setGroupSelection(null);
                          }}
                          style={({ pressed }) => [
                            styles.groupOption,
                            {
                              backgroundColor: active ? c.primary : c.card,
                              borderColor: active ? c.primary : c.border,
                              opacity: pressed ? 0.76 : 1,
                            },
                          ]}
                        >
                          <Text style={[styles.groupOptionText, { color: active ? c.primaryForeground : c.foreground }]}>
                            {type}
                          </Text>
                          <Feather
                            name={active ? 'check' : 'chevron-right'}
                            size={15}
                            color={active ? c.primaryForeground : c.mutedForeground}
                          />
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {selectedProductType ? (
                  <View style={styles.groupStep}>
                    <Text style={[styles.groupStepLabel, { color: c.mutedForeground }]}>Variante</Text>
                    <View style={styles.groupOptionList}>
                      {variants.map((variant) => {
                        const active = selectedVariant === variant;
                        return (
                          <Pressable
                            key={variant}
                            testID={`product-group-variant-${variant}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            onPress={() => {
                              setSelectedVariant(variant);
                              setSelectedGroupId(null);
                              setGroupSelection(null);
                            }}
                            style={({ pressed }) => [
                              styles.groupOption,
                              {
                                backgroundColor: active ? c.primary : c.card,
                                borderColor: active ? c.primary : c.border,
                                opacity: pressed ? 0.76 : 1,
                              },
                            ]}
                          >
                            <Text style={[styles.groupOptionText, { color: active ? c.primaryForeground : c.foreground }]}>
                              {variant}
                            </Text>
                            <Feather
                              name={active ? 'check' : 'chevron-right'}
                              size={15}
                              color={active ? c.primaryForeground : c.mutedForeground}
                            />
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}

                {selectedProductType && selectedVariant ? (
                  <View style={styles.groupStep}>
                    <Text style={[styles.groupStepLabel, { color: c.mutedForeground }]}>Formato</Text>
                    <View style={styles.groupOptionList}>
                      {packageGroups.map((group) => {
                        const active = selectedGroupId === group.id;
                        return (
                          <Pressable
                            key={group.id}
                            testID={`product-group-package-${group.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={`Selecionar ${group.name}`}
                            accessibilityState={{ selected: active }}
                            onPress={() => {
                              setSelectedGroupId(group.id);
                              setGroupSelection(null);
                            }}
                            style={({ pressed }) => [
                              styles.groupOption,
                              {
                                backgroundColor: active ? c.primary : c.card,
                                borderColor: active ? c.primary : c.border,
                                opacity: pressed ? 0.76 : 1,
                              },
                            ]}
                          >
                            <Text style={[styles.groupOptionText, { color: active ? c.primaryForeground : c.foreground }]}>
                              {formatProductGroupPackage(group)}
                            </Text>
                            <Feather
                              name={active ? 'check' : 'chevron-right'}
                              size={15}
                              color={active ? c.primaryForeground : c.mutedForeground}
                            />
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}

                {selectedProductGroup ? (
                  <View
                    testID="home-product-group-brands"
                    style={styles.groupBrandSection}
                  >
                    <Text style={[styles.groupStepLabel, { color: c.foreground }]}>Escolhe a marca</Text>
                    {productGroupMembersQuery.isPending && !productGroupMembersQuery.data ? (
                      <View testID="home-group-brands-loading" style={styles.groupLoading}>
                        <ActivityIndicator size="small" color={c.primary} />
                        <Text style={[styles.stateBody, { color: c.mutedForeground }]}>
                          A carregar marcas deste grupo...
                        </Text>
                      </View>
                    ) : productGroupMembersQuery.error && !productGroupMembersQuery.data ? (
                      <View style={styles.groupBrandState}>
                        <Text
                          testID="home-group-brands-error"
                          accessibilityRole="alert"
                          style={[styles.stateBody, { color: c.tomato }]}
                        >
                          Não foi possível carregar os produtos e marcas deste grupo.
                        </Text>
                        <Pressable
                          testID="retry-home-group-brands"
                          accessibilityRole="button"
                          onPress={() => { void productGroupMembersQuery.refetch(); }}
                          style={({ pressed }) => [
                            styles.retry,
                            { borderColor: c.primary, opacity: pressed ? 0.72 : 1 },
                          ]}
                        >
                          <Text style={[styles.retryText, { color: c.primary }]}>Tentar novamente</Text>
                        </Pressable>
                      </View>
                    ) : productGroupMembers.length === 0 ? (
                      <Text
                        testID="home-group-without-products"
                        style={[styles.stateBody, { color: c.mutedForeground }]}
                      >
                        Este grupo ainda não tem produtos associados.
                      </Text>
                    ) : (
                      <>
                        {!hasValidGroupBrands ? (
                          <Text
                            testID="home-group-without-brands"
                            style={[styles.stateBody, { color: c.mutedForeground }]}
                          >
                            Não há marcas válidas neste grupo. Ainda podes escolher qualquer marca.
                          </Text>
                        ) : null}
                        <View style={styles.groupOptionList}>
                          {brandOptions.map((option, index) => {
                            const active =
                              groupSelection?.groupId === selectedProductGroup.id &&
                              groupSelection.brand === option.value;
                            return (
                              <Pressable
                                key={`${option.kind}-${option.value ?? 'any'}`}
                                testID={option.kind === 'any' ? 'product-group-brand-any' : `product-group-brand-${index}`}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                onPress={() => {
                                  setGroupSelection(
                                    createProductGroupSelection(selectedProductGroup.id, option),
                                  );
                                }}
                                style={({ pressed }) => [
                                  styles.groupOption,
                                  styles.groupBrandOption,
                                  {
                                    backgroundColor: active ? c.primary : c.card,
                                    borderColor: active ? c.primary : c.border,
                                    opacity: pressed ? 0.76 : 1,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.groupOptionText,
                                    styles.groupBrandOptionText,
                                    { color: active ? c.primaryForeground : c.foreground },
                                  ]}
                                >
                                  {option.label}
                                </Text>
                                <Feather
                                  name={active ? 'check' : 'chevron-right'}
                                  size={15}
                                  color={active ? c.primaryForeground : c.mutedForeground}
                                />
                              </Pressable>
                            );
                          })}
                        </View>
                      </>
                    )}

                    {groupSelection?.groupId === selectedProductGroup.id ? (
                      <>
                      <View
                        testID="home-product-group-selected"
                        accessibilityLiveRegion="polite"
                        style={[styles.groupConfirmation, { backgroundColor: c.leafSoft }]}
                      >
                        <Feather name="check-circle" size={18} color={c.primary} />
                        <View style={styles.groupConfirmationCopy}>
                          <Text style={[styles.groupConfirmationTitle, { color: c.foreground }]}>
                            {selectedProductGroup.name} · {
                              brandOptions.find((option) => option.value === groupSelection.brand)?.label ??
                              (groupSelection.brand === null ? 'Qualquer marca' : groupSelection.brand)
                            }
                          </Text>
                          <Text style={[styles.groupConfirmationBody, { color: c.mutedForeground }]}>
                            Escolha genérica; ainda sem produto ou preço associado.
                          </Text>
                        </View>
                      </View>
                      <Pressable
                        testID="home-add-product-group"
                        accessibilityRole="button"
                        accessibilityLabel={`Adicionar ${selectedProductGroup.name} ao cabaz`}
                        onPress={() => {
                          const brandLabel = groupSelection.brand === null
                            ? undefined
                            : brandOptions.find((option) => option.value === groupSelection.brand)?.label ??
                              groupSelection.brand;
                          addProductGroup({
                            groupId: selectedProductGroup.id,
                            groupName: selectedProductGroup.name,
                            brand: groupSelection.brand,
                            ...(brandLabel ? { brandLabel } : {}),
                          });
                          setLastAdded(
                            `${selectedProductGroup.name} · ${brandLabel ?? 'Qualquer marca'}`,
                          );
                          setTimeout(() => setLastAdded(null), 2200);
                        }}
                        style={({ pressed }) => [
                          styles.groupAddButton,
                          { backgroundColor: c.primary, opacity: pressed ? 0.76 : 1 },
                        ]}
                      >
                        <Feather name="plus" size={17} color={c.primaryForeground} />
                        <Text style={[styles.groupAddButtonText, { color: c.primaryForeground }]}>
                          Adicionar ao cabaz
                        </Text>
                      </Pressable>
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeading}>
            <View>
              <Text accessibilityRole="header" style={[styles.sectionTitle, { color: c.foreground }]}>Produtos</Text>
              <Text style={[styles.sectionSubline, { color: c.mutedForeground }]}>Adiciona diretamente ao teu cabaz</Text>
            </View>
          </View>

          <View style={[styles.productsCard, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={[styles.catalogNote, { backgroundColor: c.muted }]}>
              <Feather name="shield" size={15} color={c.primary} />
              <Text style={[styles.catalogNoteText, { color: c.foreground }]}>
                Produtos reais do catálogo. Preços ainda não disponíveis.
              </Text>
            </View>
            {productsLoading ? (
              <View>
                {[0, 1, 2, 3].map((item) => <ProductSkeleton key={item} color={c.border} muted={c.muted} />)}
              </View>
            ) : productsError ? (
              <View style={styles.state}>
                <View style={[styles.stateIcon, { backgroundColor: c.muted }]}>
                  <Feather name="wifi-off" size={21} color={c.tomato} />
                </View>
                <Text testID="home-product-error" style={[styles.stateTitle, { color: c.foreground }]}>
                  Não foi possível carregar os produtos.
                </Text>
                <Text style={[styles.stateBody, { color: c.mutedForeground }]}>
                  Não mostramos produtos fictícios quando o catálogo falha.
                </Text>
                <Pressable
                  testID="retry-home-products"
                  accessibilityRole="button"
                  onPress={() => { void productsQuery.refetch(); }}
                  style={({ pressed }) => [styles.retry, { borderColor: c.primary, opacity: pressed ? 0.72 : 1 }]}
                >
                  <Text style={[styles.retryText, { color: c.primary }]}>Tentar novamente</Text>
                </Pressable>
              </View>
            ) : productsFromServer.length === 0 ? (
              <View style={styles.state}>
                <View style={[styles.stateIcon, { backgroundColor: c.leafSoft }]}>
                  <Feather name="search" size={21} color={c.primary} />
                </View>
                <Text testID="home-product-empty" style={[styles.stateTitle, { color: c.foreground }]}>
                  {normalizedQuery || category ? 'Não encontramos produtos.' : 'Ainda não há produtos disponíveis.'}
                </Text>
                <Text style={[styles.stateBody, { color: c.mutedForeground }]}>
                  {normalizedQuery || category ? 'Experimenta outra pesquisa ou categoria.' : 'Os produtos reais aparecerão aqui quando estiverem disponíveis.'}
                </Text>
              </View>
            ) : (
              <>
                {productsFromServer.map((product) => (
                  <HomeProductRow
                    key={product.id}
                    product={product}
                    quantity={quantities[product.id] ?? 0}
                    onAdd={() => handleAdd(product)}
                  />
                ))}
                {productsQuery.hasNextPage ? (
                  <View>
                    {productsQuery.isFetchNextPageError ? (
                      <Text style={[styles.pageError, { color: c.mutedForeground }]}>
                        Não foi possível carregar mais produtos.
                      </Text>
                    ) : null}
                    <Pressable
                      testID="load-more-home-products"
                      accessibilityRole="button"
                      onPress={() => { void productsQuery.fetchNextPage(); }}
                      disabled={productsQuery.isFetchingNextPage}
                      style={({ pressed }) => [styles.moreButton, { borderTopColor: c.border, opacity: pressed || productsQuery.isFetchingNextPage ? 0.6 : 1 }]}
                    >
                      <Text style={[styles.moreText, { color: c.primary }]}>
                        {productsQuery.isFetchingNextPage
                          ? 'A carregar...'
                          : productsQuery.isFetchNextPageError
                            ? 'Tentar novamente'
                            : 'Ver mais produtos'}
                      </Text>
                      <Feather name={productsQuery.isFetchNextPageError ? 'refresh-cw' : 'arrow-down'} size={15} color={c.primary} />
                    </Pressable>
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>

        <Pressable
          testID="card-ultimo-cabaz"
          accessibilityRole="button"
          accessibilityLabel="Abrir o meu cabaz e cabazes guardados"
          onPress={() => router.navigate('/cabaz')}
          style={({ pressed }) => [styles.basketCard, { backgroundColor: c.primary, opacity: pressed ? 0.88 : 1 }]}
        >
          <View style={[styles.basketCardIcon, { backgroundColor: c.secondary }]}>
            <Feather name="shopping-bag" size={21} color={c.primaryForeground} />
          </View>
          <View style={styles.basketCardCopy}>
            <Text style={[styles.basketCardTitle, { color: c.primaryForeground }]}>
              {totalQuantity > 0 ? 'O teu cabaz está a ganhar forma' : 'O teu cabaz, sempre à mão'}
            </Text>
            <Text style={[styles.basketCardBody, { color: c.primaryForeground }]}>
              {totalQuantity > 0
                ? `${totalQuantity} ${totalQuantity === 1 ? 'produto' : 'produtos'} · abrir cabaz e guardados`
                : 'Começa a juntar produtos e consulta os cabazes guardados'}
            </Text>
          </View>
          <Feather name="arrow-up-right" size={19} color={c.primaryForeground} />
        </Pressable>

        <Text style={[styles.footerNote, { color: c.mutedForeground }]}>
          O Cabaz Mais ou Menos compara quando existirem dados de preços. Nunca inventamos valores.
        </Text>
        {lastAdded ? (
          <View accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: c.foreground }]}>
            <Feather name="check" size={16} color={c.secondary} />
            <Text style={[styles.toastText, { color: c.card }]} numberOfLines={1}>{lastAdded} adicionado ao cabaz</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ProductSkeleton({ color, muted }: { color: string; muted: string }) {
  return (
    <View style={styles.skeletonRow}>
      <View style={[styles.skeletonImage, { backgroundColor: muted }]} />
      <View style={styles.skeletonCopy}>
        <View style={[styles.skeletonLine, { backgroundColor: color, width: '38%' }]} />
        <View style={[styles.skeletonLine, { backgroundColor: color, width: '78%' }]} />
        <View style={[styles.skeletonLine, { backgroundColor: color, width: '52%' }]} />
      </View>
      <View style={[styles.skeletonButton, { backgroundColor: muted }]} />
    </View>
  );
}

function HomeProductRow({
  product,
  quantity,
  onAdd,
}: {
  product: CatalogProduct;
  quantity: number;
  onAdd: () => void;
}) {
  const c = useColors();
  const meta = [product.brand, product.unit].filter(Boolean).join(' · ');
  return (
    <View style={[styles.productRow, { borderBottomColor: c.border }]}>
      <View style={[styles.productPlaceholder, { backgroundColor: c.muted }]}>
        <Feather name="package" size={22} color={c.primary} />
        <View style={[styles.placeholderLeaf, { backgroundColor: c.secondary }]} />
      </View>
      <View style={styles.productCopy}>
        <Text style={[styles.productName, { color: c.foreground }]} numberOfLines={2}>{product.name}</Text>
        <Text style={[styles.productMeta, { color: c.mutedForeground }]} numberOfLines={1}>
          {meta || 'Informação de marca indisponível'}
        </Text>
      </View>
      <Pressable
        testID={`home-add-product-${product.id}`}
        accessibilityRole="button"
        accessibilityLabel={quantity > 0 ? `Adicionar mais ${product.name}. Já tens ${quantity}` : `Adicionar ${product.name} ao cabaz`}
        onPress={onAdd}
        style={({ pressed }) => [
          styles.addButton,
          { backgroundColor: quantity > 0 ? c.leafSoft : c.primary, opacity: pressed ? 0.76 : 1 },
        ]}
      >
        <Feather name="plus" size={16} color={quantity > 0 ? c.primary : c.primaryForeground} />
        <Text style={[styles.addButtonText, { color: quantity > 0 ? c.primary : c.primaryForeground }]}>
          {quantity > 0 ? `${quantity}` : 'Adicionar'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 18, gap: 19, maxWidth: 600, width: '100%', alignSelf: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  brandGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 42, height: 42 },
  brand: { fontFamily: font.bold, fontSize: 18, lineHeight: 20, letterSpacing: -0.5 },
  brandAccent: { fontFamily: font.bold, fontSize: 16, lineHeight: 18, letterSpacing: -0.4 },
  basketButton: {
    width: 43,
    height: 43,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantityDot: { position: 'absolute', top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  quantityText: { fontFamily: font.bold, fontSize: 10 },
  slogan: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, marginTop: -10 },
  search: { minHeight: 52, borderRadius: 17, borderWidth: 1, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchInput: { flex: 1, minWidth: 0, fontFamily: font.medium, fontSize: 15, paddingVertical: 12 },
  zoneCard: { minHeight: 67, borderRadius: 19, borderWidth: 1, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 11 },
  zoneIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  zoneCopy: { flex: 1, minWidth: 0, gap: 2 },
  zoneLabel: { fontFamily: font.medium, fontSize: 11, lineHeight: 15 },
  zoneValue: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20 },
  zoneError: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, marginTop: -11 },
  section: { gap: 11 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { fontFamily: font.bold, fontSize: 20, lineHeight: 25, letterSpacing: -0.5 },
  sectionHint: { fontFamily: font.medium, fontSize: 11 },
  sectionSubline: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, marginTop: 1 },
  categoryList: { gap: 9, paddingRight: 18 },
  categorySkeleton: { width: 102, height: 60, borderRadius: 18 },
  categoryChip: { minHeight: 60, borderRadius: 18, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 7 },
  categoryIcon: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  categoryLabel: { fontFamily: font.semibold, fontSize: 12 },
  categoryError: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  categoryErrorText: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, flex: 1 },
  groupSelectorContent: { padding: 14, gap: 15 },
  groupBrandSection: { gap: 10 },
  groupBrandState: { alignItems: 'center', gap: 8, paddingVertical: 6 },
  groupStep: { gap: 8 },
  groupStepLabel: { fontFamily: font.semibold, fontSize: 11, lineHeight: 15 },
  groupOptionList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groupOption: {
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  groupOptionText: { fontFamily: font.semibold, fontSize: 13 },
  groupBrandOption: { flexShrink: 1 },
  groupBrandOptionText: { flexShrink: 1 },
  groupLoading: { minHeight: 92, alignItems: 'center', justifyContent: 'center', gap: 8 },
  groupConfirmation: { borderRadius: 15, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  groupConfirmationCopy: { flex: 1, gap: 3 },
  groupConfirmationTitle: { fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  groupConfirmationBody: { fontFamily: font.regular, fontSize: 11, lineHeight: 16 },
  groupAddButton: { minHeight: 46, borderRadius: 13, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  groupAddButtonText: { fontFamily: font.semibold, fontSize: 14 },
  productsCard: { borderRadius: 22, borderWidth: 1, overflow: 'hidden' },
  catalogNote: { paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  catalogNoteText: { flex: 1, fontFamily: font.medium, fontSize: 11, lineHeight: 15 },
  productRow: { minHeight: 82, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  productPlaceholder: { width: 54, height: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  placeholderLeaf: { width: 9, height: 15, borderRadius: 8, position: 'absolute', top: 9, right: 10, transform: [{ rotate: '38deg' }] },
  productCopy: { flex: 1, minWidth: 0, gap: 3 },
  productName: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18 },
  productMeta: { fontFamily: font.regular, fontSize: 12, lineHeight: 16 },
  addButton: { minHeight: 39, borderRadius: 13, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 43 },
  addButtonText: { fontFamily: font.semibold, fontSize: 11 },
  moreButton: { minHeight: 46, borderTopWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  moreText: { fontFamily: font.semibold, fontSize: 12 },
  pageError: { fontFamily: font.regular, fontSize: 11, textAlign: 'center', paddingTop: 10, paddingHorizontal: 12 },
  state: { paddingHorizontal: 22, paddingVertical: 28, alignItems: 'center', gap: 8 },
  stateIcon: { width: 45, height: 45, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  stateTitle: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, textAlign: 'center' },
  stateBody: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, textAlign: 'center', maxWidth: 280 },
  retry: { minHeight: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center', marginTop: 5 },
  retryText: { fontFamily: font.semibold, fontSize: 12 },
  skeletonRow: { minHeight: 82, paddingHorizontal: 12, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  skeletonImage: { width: 54, height: 54, borderRadius: 17 },
  skeletonCopy: { flex: 1, gap: 7 },
  skeletonLine: { height: 8, borderRadius: 4 },
  skeletonButton: { width: 60, height: 35, borderRadius: 12 },
  basketCard: { minHeight: 83, borderRadius: 22, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 11 },
  basketCardIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  basketCardCopy: { flex: 1, minWidth: 0, gap: 3 },
  basketCardTitle: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19 },
  basketCardBody: { fontFamily: font.regular, fontSize: 11, lineHeight: 16, opacity: 0.9 },
  footerNote: { fontFamily: font.regular, fontSize: 11, lineHeight: 16, textAlign: 'center', paddingHorizontal: 16 },
  toast: { position: 'absolute', bottom: 86, left: 18, right: 18, minHeight: 44, borderRadius: 14, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 8 },
  toastText: { flex: 1, fontFamily: font.semibold, fontSize: 12 },
});
