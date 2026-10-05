import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, EmptyState, ScreenTitle, SectionHeader, font } from '@/components/ui';
import { BasketRow } from '@/components/products/BasketRow';
import { DemoPriceBadge } from '@/components/products/DemoPriceBadge';
import { ProductCatalogModal } from '@/components/products/ProductCatalogModal';
import { SavedBaskets } from '@/components/basket/SavedBaskets';
import { useBasket } from '@/context/BasketContext';
import { useZone } from '@/context/ZoneContext';
import { useColors } from '@/hooks/useColors';
import { getBasketItemIdentity, isExactBasketItem } from '@/lib/basket';
import { formatDemoPrice } from '@/lib/products';

export default function CabazScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { zone, isLoading } = useZone();
  const {
    items,
    totalCents,
    totalQuantity,
    increaseQuantity,
    decreaseQuantity,
    removeProduct,
    increaseProductGroupQuantity,
    decreaseProductGroupQuantity,
    removeProductGroup,
  } = useBasket();
  const hasGroup = items.some((item) => item.kind === 'group');
  const exactItems = items.filter(isExactBasketItem);
  const hasRemote = exactItems.some((item) => !item.product.isDemo);
  const hasDemo = exactItems.some((item) => item.product.isDemo);
  const totalLabel = hasGroup
    ? 'Preço não disponível nesta fase'
    : totalCents === null ? 'Preço indisponível' : formatDemoPrice(totalCents);
  const [catalogOpen, setCatalogOpen] = useState<boolean>(false);
  const top = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <>
      <ScrollView
        testID="screen-cabaz"
        style={{ backgroundColor: c.background }}
        contentContainerStyle={[styles.content, { paddingTop: top + 24, paddingBottom: insets.bottom + 120 }]}
        showsVerticalScrollIndicator={false}
      >
        <ScreenTitle kicker="O teu plano" title="Meu cabaz" />
          <DemoPriceBadge
            label={hasGroup ? 'Escolhas por grupo' : hasRemote && !hasDemo ? 'Catálogo de produtos' : undefined}
            detail={hasGroup
              ? 'As escolhas por grupo ainda não correspondem a um produto nem têm preço associado.'
              : hasRemote && !hasDemo
                ? 'Preços ainda não disponíveis para estes produtos.'
                : hasRemote
                  ? 'Os preços dos produtos de demonstração são fictícios; os restantes ainda não têm preço.'
                  : 'Produtos e marcas fictícios. Não são preços reais.'}
          />

        <Pressable
          testID="button-alterar-zona"
          accessibilityRole="button"
          accessibilityLabel={zone ? `Zona ${zone}. Alterar zona` : 'Escolher zona'}
          accessibilityState={{ disabled: isLoading }}
          disabled={isLoading}
          onPress={() => router.push('/escolher-zona')}
          style={({ pressed }) => [
            styles.zone,
            { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <View style={[styles.zoneIcon, { backgroundColor: c.leafSoft }]}>
            <Feather name="map-pin" size={18} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.zoneLabel, { color: c.mutedForeground }]}>Zona</Text>
            <Text style={[styles.zoneValue, { color: c.foreground }]}>{isLoading ? 'A carregar...' : zone ?? 'Ainda por escolher'}</Text>
          </View>
          <Text style={[styles.zoneAction, { color: c.primary }]}>{zone ? 'Alterar' : 'Escolher'}</Text>
        </Pressable>

        <Button
          testID="button-adicionar-produto"
          label="Adicionar produto"
          icon="plus"
          onPress={() => setCatalogOpen(true)}
        />

        {items.length === 0 ? (
          <EmptyState
            icon="shopping-bag"
            eyebrow="Cabaz vazio"
            title="Ainda não há nada no teu cabaz"
            body="Junta os produtos que compras habitualmente. Total atual: 0,00 €."
            note="O cabaz é guardado neste dispositivo. Os preços de demonstração são fictícios."
          />
        ) : (
          <View style={{ gap: 10 }}>
            <SectionHeader
              title="Produtos"
              hint={`${totalQuantity} ${totalQuantity === 1 ? 'unidade' : 'unidades'} · Guardado neste dispositivo`}
            />
            {items.map((item) => (
              <BasketRow
                key={getBasketItemIdentity(item)}
                item={item}
                onIncrease={() => item.kind === 'group'
                  ? increaseProductGroupQuantity(item.groupId, item.brand)
                  : increaseQuantity(item.product.id)}
                onDecrease={() => item.kind === 'group'
                  ? decreaseProductGroupQuantity(item.groupId, item.brand)
                  : decreaseQuantity(item.product.id)}
                onRemove={() => item.kind === 'group'
                  ? removeProductGroup(item.groupId, item.brand)
                  : removeProduct(item.product.id)}
              />
            ))}
          </View>
        )}

        <SavedBaskets />

        <View style={[styles.total, { backgroundColor: c.primary, borderRadius: c.radius + 4 }]}>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: c.primaryForeground }]}>Total do cabaz</Text>
            <Text
              testID="basket-total"
               accessibilityLabel={`Total ${totalLabel}${totalCents === null ? '' : ', preços de demonstração'}`}
              style={[styles.totalValue, { color: c.primaryForeground }]}
            >
               {totalLabel}
            </Text>
          </View>
           <DemoPriceBadge
             label={hasGroup ? 'Escolhas por grupo' : hasRemote && !hasDemo ? 'Catálogo de produtos' : undefined}
             detail={hasGroup
               ? 'O total não inclui escolhas por grupo, que ainda não têm preço associado.'
               : hasRemote && !hasDemo
                 ? 'Total indisponível: faltam preços para produtos deste cabaz.'
                 : hasRemote
                   ? 'Total indisponível: faltam preços para produtos deste cabaz. Os preços de demonstração não são reais.'
                   : 'Valores fictícios. Não correspondem a preços reais de nenhuma loja.'}
           />
        </View>

        <Button
          testID="button-ver-comparacao"
          variant="secondary"
          label="Comparar preços"
          icon="bar-chart-2"
          onPress={() => router.navigate('/comparar')}
        />
      </ScrollView>
      <ProductCatalogModal visible={catalogOpen} onClose={() => setCatalogOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, gap: 20, maxWidth: 560, width: '100%', alignSelf: 'center' },
  zone: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderWidth: 1, marginTop: 8 },
  zoneIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  zoneLabel: { fontFamily: font.medium, fontSize: 12 },
  zoneValue: { fontFamily: font.semibold, fontSize: 16, marginTop: 1 },
  zoneAction: { fontFamily: font.semibold, fontSize: 14 },
  total: { padding: 18, gap: 14 },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  totalLabel: { fontFamily: font.semibold, fontSize: 15 },
  totalValue: { fontFamily: font.bold, fontSize: 30, letterSpacing: -0.8 },
});
