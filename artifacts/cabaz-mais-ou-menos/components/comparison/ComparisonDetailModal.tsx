import React from 'react';
import { Feather } from '@expo/vector-icons';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { formatDemoPrice } from '@/lib/products';
import type { StoreComparison } from '@/lib/comparison';

interface ComparisonDetailModalProps {
  result: StoreComparison | null;
  onClose: () => void;
}

export function ComparisonDetailModal({ result, onClose }: ComparisonDetailModalProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? 67 : insets.top;
  const bottom = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <Modal
      visible={result !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.modal, { backgroundColor: c.background }]}>
        {result ? (
          <ScrollView
            testID={`comparison-detail-${result.storeId}`}
            style={{ backgroundColor: c.background }}
            contentContainerStyle={[
              styles.content,
              { paddingTop: top + 18, paddingBottom: bottom + 24 },
            ]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.kicker, { color: c.primary }]}>DETALHE DA COMPARAÇÃO</Text>
                <Text accessibilityRole="header" style={[styles.title, { color: c.foreground }]}>
                  {result.storeName}
                </Text>
                {result.isOnline ? (
                  <Text testID="comparison-detail-online" style={[styles.kicker, { color: c.primary }]}>
                    Online · sem associação a loja física
                  </Text>
                ) : null}
              </View>
              <Pressable
                testID="comparison-detail-close"
                accessibilityRole="button"
                accessibilityLabel="Fechar detalhe da comparação"
                hitSlop={8}
                onPress={onClose}
                style={({ pressed }) => [styles.close, { opacity: pressed ? 0.65 : 1 }]}
              >
                <Feather name="x" size={24} color={c.foreground} />
              </Pressable>
            </View>

            <View style={[styles.summary, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}>
              <View style={[styles.status, { backgroundColor: result.isComplete ? c.leafSoft : c.muted }]}>
                {result.isComplete ? <Feather name="check" size={13} color={c.primary} /> : null}
                <Text style={[styles.statusText, { color: result.isComplete ? c.primary : c.tomato }]}>
                  {result.isComplete ? 'Comparação completa' : 'Comparação parcial'}
                </Text>
              </View>
              <Text style={[styles.summaryLabel, { color: c.mutedForeground }]}>TOTAL DO CABAZ</Text>
              <Text style={[styles.summaryTotal, { color: result.totalCents === null ? c.mutedForeground : c.foreground }]}>
                {result.totalCents === null ? 'Preço não disponível' : formatDemoPrice(result.totalCents)}
              </Text>
            </View>

            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: c.foreground }]}>
                {result.includesProductGroups ? 'Linhas do cabaz' : 'Produtos do cabaz'}
              </Text>
              {(result.lines ?? []).map((line) => {
                const unavailable = line.unitPriceCents === null || line.subtotalCents === null;
                const lineId = line.lineKey ?? line.productId ?? line.name;
                const chosenBrand = line.chosenProductBrand?.trim();
                return (
                  <View
                    key={lineId}
                    testID={`comparison-detail-line-${result.storeId}-${lineId}`}
                    style={[styles.product, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}
                  >
                    <Text style={[styles.productName, { color: c.foreground }]}>{line.name}</Text>
                    {line.kind === 'group' ? (
                      <>
                        <Text style={[styles.quantity, { color: c.mutedForeground }]}>
                          Marca pedida: {line.requestedBrandLabel}
                        </Text>
                        {line.chosenProductName ? (
                          <Text style={[styles.quantity, { color: c.primary }]}>
                            Produto escolhido: {line.chosenProductName}{chosenBrand ? ` · ${chosenBrand}` : ''}
                          </Text>
                        ) : (
                          <Text style={[styles.quantity, { color: c.tomato }]}>
                            Nenhum SKU elegível com preço válido nesta loja.
                          </Text>
                        )}
                      </>
                    ) : null}
                    <Text style={[styles.quantity, { color: c.mutedForeground }]}>
                      {line.quantity} × {unavailable ? 'Preço não disponível' : formatDemoPrice(line.unitPriceCents!)}
                    </Text>
                    <Text style={[styles.subtotal, { color: unavailable ? c.tomato : c.foreground }]}>
                      Subtotal: {line.subtotalCents === null ? 'Preço não disponível' : formatDemoPrice(line.subtotalCents)}
                    </Text>
                  </View>
                );
              })}
            </View>

            <View style={[styles.counts, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}>
              <View style={styles.countRow}>
                <Text style={[styles.countLabel, { color: c.mutedForeground }]}>
                  {result.includesProductGroups ? 'Linhas com preço' : 'Produtos encontrados'}
                </Text>
                <Text testID={`comparison-detail-found-${result.storeId}`} style={[styles.countValue, { color: c.foreground }]}>
                  {result.foundProducts}
                </Text>
              </View>
              <View style={styles.countRow}>
                <Text style={[styles.countLabel, { color: c.mutedForeground }]}>
                  {result.includesProductGroups ? 'Linhas em falta' : 'Produtos em falta'}
                </Text>
                <Text
                  testID={`comparison-detail-missing-count-${result.storeId}`}
                  style={[styles.countValue, { color: result.missingProducts > 0 ? c.tomato : c.foreground }]}
                >
                  {result.missingProducts}
                </Text>
              </View>
              <View style={[styles.updated, { borderTopColor: c.border }]}>
                <Text style={[styles.updatedLabel, { color: c.mutedForeground }]}>Última atualização dos preços</Text>
                <Text testID={`comparison-detail-updated-${result.storeId}`} style={[styles.updatedValue, { color: c.foreground }]}>
                  {result.latestCapturedAt
                    ? new Date(result.latestCapturedAt).toLocaleString('pt-PT', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Sem preços disponíveis'}
                </Text>
              </View>
            </View>

            {result.missingProducts > 0 ? (
              <View
                testID={`comparison-detail-missing-${result.storeId}`}
                style={[styles.missing, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}
              >
                <Text style={[styles.sectionTitle, { color: c.foreground }]}>
                  {result.includesProductGroups ? 'Linhas em falta' : 'Produtos em falta'}
                </Text>
                {(result.lines ?? [])
                  .filter((line) => line.subtotalCents === null)
                  .map((line) => (
                    <View key={line.lineKey ?? line.productId ?? line.name} style={styles.missingProduct}>
                      <Feather name="alert-circle" size={15} color={c.tomato} />
                      <Text style={[styles.missingName, { color: c.foreground }]}>
                        {line.name}{line.kind === 'group' ? ` · ${line.requestedBrandLabel}` : ''}
                      </Text>
                      <Text style={[styles.missingPrice, { color: c.tomato }]}>Preço não disponível</Text>
                    </View>
                  ))}
              </View>
            ) : null}

            <View
              testID={`comparison-detail-total-${result.storeId}`}
              style={[styles.finalTotal, { backgroundColor: c.primary, borderRadius: c.radius }]}
            >
              <Text style={[styles.finalTotalLabel, { color: c.primaryForeground }]}>TOTAL</Text>
              <Text style={[styles.finalTotalValue, { color: c.primaryForeground }]}>
                {result.totalCents === null ? 'Preço não disponível' : formatDemoPrice(result.totalCents)}
              </Text>
            </View>
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  kicker: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.2 },
  title: { fontFamily: font.bold, fontSize: 25, letterSpacing: -0.6, marginTop: 4 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  summary: { borderWidth: 1, padding: 18, gap: 8 },
  status: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  statusText: { fontFamily: font.semibold, fontSize: 12 },
  summaryLabel: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.1, marginTop: 5 },
  summaryTotal: { fontFamily: font.bold, fontSize: 30, fontVariant: ['tabular-nums'] },
  section: { gap: 9 },
  sectionTitle: { fontFamily: font.bold, fontSize: 16 },
  product: { borderWidth: 1, padding: 14, gap: 4 },
  productName: { fontFamily: font.semibold, fontSize: 16 },
  quantity: { fontFamily: font.medium, fontSize: 14 },
  subtotal: { fontFamily: font.semibold, fontSize: 14, marginTop: 2 },
  counts: { borderWidth: 1, padding: 15, gap: 12 },
  countRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  countLabel: { fontFamily: font.medium, fontSize: 14 },
  countValue: { fontFamily: font.bold, fontSize: 15, fontVariant: ['tabular-nums'] },
  updated: { borderTopWidth: 1, paddingTop: 12, gap: 4, marginTop: 2 },
  updatedLabel: { fontFamily: font.medium, fontSize: 13 },
  updatedValue: { fontFamily: font.semibold, fontSize: 14 },
  missing: { borderWidth: 1, padding: 15, gap: 11 },
  missingProduct: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  missingName: { fontFamily: font.medium, fontSize: 14, flex: 1, minWidth: 120 },
  missingPrice: { fontFamily: font.semibold, fontSize: 12 },
  finalTotal: { padding: 18, gap: 2, marginTop: 2 },
  finalTotalLabel: { fontFamily: font.bold, fontSize: 12, letterSpacing: 1.2 },
  finalTotalValue: { fontFamily: font.bold, fontSize: 30, fontVariant: ['tabular-nums'] },
});