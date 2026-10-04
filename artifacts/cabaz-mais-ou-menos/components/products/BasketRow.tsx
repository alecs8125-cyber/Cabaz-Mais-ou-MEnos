import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import {
  getBasketItemBrandLabel,
  getBasketItemIdentity,
  type BasketItem,
} from '@/lib/basket';
import { formatDemoPrice } from '@/lib/products';

type Props = {
  item: BasketItem;
  onIncrease: () => void;
  onDecrease: () => void;
  onRemove: () => void;
};

export function BasketRow({ item, onIncrease, onDecrease, onRemove }: Props) {
  const c = useColors();
  const isGroup = item.kind === 'group';
  const identity = getBasketItemIdentity(item);
  const controlId = isGroup ? identity : item.product.id;
  const name = isGroup ? item.groupName : item.product.name;
  const brand = getBasketItemBrandLabel(item);
  const quantity = item.quantity;
  const atMin = quantity <= 1;
  return (
    <View
      testID={isGroup ? `basket-item-${identity}` : `basket-item-${item.product.id}`}
      style={[styles.row, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}
    >
      <View style={styles.top}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={2}>{name}</Text>
          <Text style={[styles.meta, { color: c.mutedForeground }]}>
            {isGroup
              ? `Quantidade: ${quantity} · ${brand}`
              : `${quantity}${item.product.unit ? ` × ${item.product.unit}` : ''}${brand ? ` · ${brand}` : ''}`}
          </Text>
        </View>
        <Pressable
          testID={`remove-${controlId}`}
          accessibilityRole="button"
          accessibilityLabel={`Remover ${name} do cabaz`}
          hitSlop={6}
          onPress={onRemove}
          style={({ pressed }) => [styles.remove, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="trash-2" size={16} color={c.destructive} />
          <Text style={[styles.removeText, { color: c.destructive }]}>Remover</Text>
        </Pressable>
      </View>
      <View style={styles.bottom}>
        <View style={[styles.stepper, { backgroundColor: c.muted, borderRadius: c.radius - 4 }]}>
          <Pressable
            testID={`decrease-${controlId}`}
            accessibilityRole="button"
            accessibilityLabel={`Diminuir quantidade de ${name}`}
            accessibilityState={{ disabled: atMin }}
            disabled={atMin}
            onPress={onDecrease}
            style={({ pressed }) => [styles.step, { opacity: atMin ? 0.35 : pressed ? 0.6 : 1 }]}
          >
            <Feather name="minus" size={18} color={c.primary} />
          </Pressable>
          <Text accessibilityLabel={`Quantidade ${quantity}`} style={[styles.qty, { color: c.foreground }]}>{quantity}</Text>
          <Pressable
            testID={`increase-${controlId}`}
            accessibilityRole="button"
            accessibilityLabel={`Aumentar quantidade de ${name}`}
            onPress={onIncrease}
            style={({ pressed }) => [styles.step, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Feather name="plus" size={18} color={c.primary} />
          </Pressable>
        </View>
        <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
          {isGroup ? (
            <Text style={[styles.unitPrice, { color: c.mutedForeground, textAlign: 'right' }]}>
              Preço não disponível nesta fase
            </Text>
          ) : (
            <>
              <Text style={[styles.unitPrice, { color: c.mutedForeground }]}>
                {item.product.demoPriceCents === null
                  ? 'Preço indisponível'
                  : `${formatDemoPrice(item.product.demoPriceCents)} / un.`}
              </Text>
              <Text style={[styles.subtotal, { color: c.foreground }]}>
                {item.subtotalCents === null ? 'Preço indisponível' : formatDemoPrice(item.subtotalCents)}
              </Text>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, padding: 14, gap: 12 },
  top: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  name: { fontFamily: font.semibold, fontSize: 16 },
  meta: { fontFamily: font.medium, fontSize: 13, marginTop: 2 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 4 },
  removeText: { fontFamily: font.semibold, fontSize: 13 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  step: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  qty: { fontFamily: font.bold, fontSize: 16, minWidth: 24, textAlign: 'center' },
  unitPrice: { fontFamily: font.regular, fontSize: 12 },
  subtotal: { fontFamily: font.bold, fontSize: 17 },
});
