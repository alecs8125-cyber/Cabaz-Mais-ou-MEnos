import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { formatDemoPrice } from '@/lib/products';
import { formatBasketCoverage } from '@/lib/comparison';
import type { StoreComparison } from '@/lib/comparison';

export function StoreResultCard({
  result,
  rank,
  onPress,
}: {
  result: StoreComparison;
  rank: number;
  onPress: () => void;
}) {
  const c = useColors();
  const r = result;
  const hasTotal = r.totalCents !== null;
  const partial = !r.isComplete;
  const showSavings = r.isComplete && r.savingsCents > 0 && !!r.savingsReferenceName;
  const label = !hasTotal ? 'PREÇO NÃO DISPONÍVEL' : partial ? 'TOTAL PARCIAL' : 'TOTAL DO CABAZ';

  return (
    <Pressable
      testID={`comparison-store-${r.storeId}`}
      accessibilityRole="button"
      accessibilityLabel={`Abrir detalhe de ${r.storeName}, ${hasTotal ? formatDemoPrice(r.totalCents!) : 'preço não disponível'}, ${formatBasketCoverage(r.foundProducts, r.requestedProducts)}, ${r.isComplete ? 'comparação completa' : 'comparação parcial'}`}
      accessibilityHint="Mostra os produtos, subtotais e estado desta comparação."
      onPress={onPress}
      style={[
        styles.card,
        {
          backgroundColor: c.card,
          borderColor: showSavings || r.isOnline ? c.primary : c.border,
          borderWidth: showSavings ? 2 : 1,
          borderRadius: c.radius,
        },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.rank, { backgroundColor: hasTotal ? c.secondary : c.muted }]}>
          <Text style={[styles.rankText, { color: c.secondaryForeground }]}>{rank}</Text>
        </View>
        <Text style={[styles.name, { color: c.foreground }]}>{r.storeName}</Text>
        <View style={[styles.pill, { backgroundColor: r.isComplete ? c.leafSoft : c.muted }]}>
          {r.isComplete ? <Feather name="check" size={12} color={c.primary} /> : null}
          <Text style={[styles.pillText, { color: r.isComplete ? c.primary : c.tomato }]}>
            {r.isComplete ? 'Comparação completa' : 'Comparação parcial'}
          </Text>
        </View>
      </View>

      {r.isRegionalReference ? (
        <View testID={`comparison-reference-${r.storeId}`} style={[styles.pill, { backgroundColor: c.leafSoft, alignSelf: 'flex-start' }]}>
          <Feather name="globe" size={13} color={c.primary} />
          <Text style={[styles.pillText, { color: c.primary }]}>Referência regional · 2650-435</Text>
        </View>
      ) : r.isOnline ? (
        <View testID={`comparison-online-${r.storeId}`} style={[styles.pill, { backgroundColor: c.leafSoft, alignSelf: 'flex-start' }]}>
          <Feather name="globe" size={13} color={c.primary} />
          <Text style={[styles.pillText, { color: c.primary }]}>Online · preço do canal online</Text>
        </View>
      ) : null}
      {r.referenceScopeNote ? (
        <Text testID={`comparison-reference-scope-${r.storeId}`} style={[styles.note, { color: c.mutedForeground }]}>
          {r.referenceScopeNote}
        </Text>
      ) : null}

      <View style={styles.totalRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: partial ? c.tomato : c.mutedForeground }]}>{label}</Text>
          <Text
            testID={`comparison-total-${r.storeId}`}
            style={[styles.total, { color: hasTotal ? c.foreground : c.mutedForeground, fontSize: hasTotal ? 30 : 18 }]}
          >
            {r.totalCents !== null ? formatDemoPrice(r.totalCents) : 'Preço não disponível'}
          </Text>
        </View>
      </View>

      {r.lines ? (
        <View style={[styles.breakdown, { borderTopColor: c.border }]}>
          {r.lines.map((line, index) => {
            const lineId = line.lineKey ?? line.productId ?? String(index);
            if (line.kind === 'group') {
              const chosenBrand = line.chosenProductBrand?.trim();
              return (
                <View
                  key={lineId}
                  testID={`comparison-line-${r.storeId}-${lineId}`}
                  style={styles.groupLine}
                >
                  <Text style={[styles.note, { color: c.foreground }]}>
                    {line.name} · {line.requestedBrandLabel}
                  </Text>
                  <Text style={[styles.note, { color: c.mutedForeground }]}>
                    {line.chosenProductName
                      ? `Produto escolhido: ${line.chosenProductName}${chosenBrand ? ` · ${chosenBrand}` : ''}`
                      : 'Nenhum SKU elegível com preço válido nesta loja.'}
                  </Text>
                  <Text style={[styles.note, { color: line.subtotalCents === null ? c.tomato : c.foreground }]}>
                    {line.subtotalCents === null
                      ? 'Preço não disponível'
                      : `${line.quantity} × ${formatDemoPrice(line.unitPriceCents!)} = ${formatDemoPrice(line.subtotalCents)}`}
                  </Text>
                </View>
              );
            }
            return (
              <Text
                key={lineId}
                testID={`comparison-line-${r.storeId}-${lineId}`}
                style={[styles.note, { color: line.subtotalCents === null ? c.tomato : c.foreground }]}
              >
                {line.name}: {line.subtotalCents === null
                  ? 'Preço não disponível'
                  : `${line.quantity} × ${formatDemoPrice(line.unitPriceCents!)} = ${formatDemoPrice(line.subtotalCents)}`}
              </Text>
            );
          })}
        </View>
      ) : null}

      <View style={[styles.counts, { borderTopColor: c.border }]}>
        <View style={styles.coverage}>
          <Text style={[styles.coverageLabel, { color: c.mutedForeground }]}>COBERTURA DO CABAZ</Text>
          <Text
            testID={`comparison-coverage-${r.storeId}`}
            style={[styles.count, { color: c.foreground }]}
          >
            {formatBasketCoverage(r.foundProducts, r.requestedProducts)}
          </Text>
        </View>
        <Text
          testID={`comparison-missing-${r.storeId}`}
          style={[styles.count, { color: r.missingProducts > 0 ? c.tomato : c.mutedForeground }]}
        >
          {r.missingProducts} {r.includesProductGroups
            ? 'linhas em falta'
            : r.missingProducts === 1 ? 'produto em falta' : 'produtos em falta'}
        </Text>
      </View>
      <View
        testID={`comparison-updated-${r.storeId}`}
        style={[styles.updated, { borderTopColor: c.border }]}
      >
        <Feather name="clock" size={13} color={c.mutedForeground} />
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          Última atualização: {r.latestCapturedAt
            ? new Date(r.latestCapturedAt).toLocaleString('pt-PT', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })
            : 'Sem preços disponíveis'}
        </Text>
      </View>

      {partial ? (
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          {r.includesProductGroups
            ? 'As linhas sem preço não entram no total — não são gratuitas. Este resultado não é comparável a um cabaz completo.'
            : 'Os produtos em falta não estão incluídos neste total — não são gratuitos. Não é comparável a um cabaz completo.'}
        </Text>
      ) : null}
      {!hasTotal ? (
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          {r.includesProductGroups
            ? 'Nenhuma linha do cabaz tem preço disponível nesta loja.'
            : 'Nenhum produto do cabaz tem preço disponível nesta loja.'}
        </Text>
      ) : null}

      {showSavings ? (
        <View
          testID={`comparison-savings-${r.storeId}`}
          style={[styles.savings, { backgroundColor: c.primary, borderRadius: c.radius - 8 }]}
        >
          <Feather name="trending-down" size={16} color={c.accent} />
          <Text style={[styles.savingsText, { color: c.primaryForeground }]}>
            Poupa {formatDemoPrice(r.savingsCents)} face a {r.savingsReferenceName}, também com o cabaz completo.
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rank: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontFamily: font.bold, fontSize: 13 },
  name: { flex: 1, minWidth: 0, fontFamily: font.semibold, fontSize: 17 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  pillText: { fontFamily: font.semibold, fontSize: 11 },
  totalRow: { flexDirection: 'row', alignItems: 'flex-end' },
  label: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.2 },
  total: { fontFamily: font.bold, marginTop: 2, fontVariant: ['tabular-nums'] },
  counts: { borderTopWidth: 1, paddingTop: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  coverage: { flex: 1, minWidth: 170, gap: 2 },
  coverageLabel: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1 },
  updated: { borderTopWidth: 1, paddingTop: 9, flexDirection: 'row', alignItems: 'center', gap: 6 },
  breakdown: { borderTopWidth: 1, paddingTop: 10, gap: 4 },
  groupLine: { gap: 3 },
  count: { fontFamily: font.medium, fontSize: 13 },
  note: { fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  savings: { flexDirection: 'row', gap: 8, padding: 10, alignItems: 'flex-start' },
  savingsText: { flex: 1, fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
});
