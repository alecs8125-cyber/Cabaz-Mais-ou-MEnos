import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

/** Selo bem visível: nenhum preço mostrado é real. */
export function DemoPriceBadge({ detail, label = 'Preços de demonstração' }: { detail?: string; label?: string }) {
  const c = useColors();
  return (
    <View
      accessible
      accessibilityLabel={`${label}${detail ? `. ${detail}` : ''}`}
      style={[styles.wrap, { backgroundColor: c.leafSoft, borderColor: c.accent, borderRadius: c.radius - 6 }]}
    >
      <Feather name="tag" size={16} color={c.tomato} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: c.primary }]}>{label}</Text>
        {detail ? <Text style={[styles.detail, { color: c.foreground }]}>{detail}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 10, padding: 12, borderWidth: 1, alignItems: 'flex-start' },
  title: { fontFamily: font.bold, fontSize: 14 },
  detail: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
});
