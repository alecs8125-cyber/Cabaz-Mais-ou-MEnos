import React, { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { radii, shadows, spacing, typography } from '@/constants/colors';

export const font = typography.family;

type ButtonProps = {
  label: string;
  onPress: () => void;
  testID: string;
  accessibilityLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'inverse';
  icon?: keyof typeof Feather.glyphMap;
  disabled?: boolean;
};

export function Button({
  label,
  onPress,
  testID,
  accessibilityLabel,
  variant = 'primary',
  icon,
  disabled,
}: ButtonProps) {
  const c = useColors();
  const bg =
    variant === 'primary'
      ? c.primary
      : variant === 'secondary'
        ? c.secondary
        : variant === 'inverse'
          ? c.card
          : 'transparent';
  const fg =
    variant === 'primary'
      ? c.primaryForeground
      : variant === 'secondary'
        ? c.secondaryForeground
        : c.primary;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: disabled ? c.muted : bg,
          borderRadius: c.radius,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: disabled ? c.mutedForeground : fg }]}>
        {label}
      </Text>
      {icon ? (
        <Feather name={icon} size={18} color={disabled ? c.mutedForeground : fg} />
      ) : null}
    </Pressable>
  );
}

/** Composição nativa do cesto: marfim sobre verde-floresta com folha fresca. */
export function BasketMark({ size = 160, inverted = false }: { size?: number; inverted?: boolean }) {
  const c = useColors();
  const s = size / 160;
  const base = inverted ? c.card : c.primary;
  const ink = inverted ? c.primary : c.background;
  const leaf = inverted ? c.tomato : c.accent;
  return (
    <View
      accessible
      accessibilityLabel="Ilustração de um cabaz"
      style={{
        width: size,
        height: size,
        borderRadius: 44 * s,
        backgroundColor: base,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          position: 'absolute',
          width: size * 0.9,
          height: size * 0.9,
          borderRadius: size,
          backgroundColor: c.accent,
          opacity: 0.14,
          top: -size * 0.35,
          right: -size * 0.3,
        }}
      />
      <View style={{ position: 'absolute', top: 30 * s, right: 42 * s, transform: [{ rotate: '-18deg' }] }}>
        <Feather name="feather" size={34 * s} color={leaf} />
      </View>
      <View style={{ marginTop: 22 * s }}>
        <Feather name="shopping-bag" size={72 * s} color={ink} />
      </View>
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: c.card,
          borderColor: c.border,
          borderRadius: c.radii.card,
          ...shadows.soft,
        },
      ]}
    >
      {children}
    </View>
  );
}

export function EmptyState({
  icon,
  eyebrow,
  title,
  body,
  note,
}: {
  icon: keyof typeof Feather.glyphMap;
  eyebrow: string;
  title: string;
  body: string;
  note: string;
}) {
  const c = useColors();
  return (
    <Card>
      <View style={[styles.emptyIcon, { backgroundColor: c.leafSoft }]}>
        <Feather name={icon} size={28} color={c.primary} />
      </View>
      <Text style={[styles.eyebrow, { color: c.tomato }]}>{eyebrow}</Text>
      <Text style={[styles.emptyTitle, { color: c.foreground }]}>{title}</Text>
      <Text style={[styles.body, { color: c.mutedForeground }]}>{body}</Text>
      <View style={[styles.note, { backgroundColor: c.muted, borderRadius: c.radius - 6 }]}>
        <Feather name="info" size={16} color={c.primary} />
        <Text style={[styles.noteText, { color: c.foreground }]}>{note}</Text>
      </View>
    </Card>
  );
}

export function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: c.foreground }]}>
        {title}
      </Text>
      {hint ? <Text style={[styles.sectionHint, { color: c.mutedForeground }]}>{hint}</Text> : null}
    </View>
  );
}

export function ScreenTitle({ kicker, title }: { kicker: string; title: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.eyebrow, { color: c.mutedForeground, marginTop: 0 }]}>{kicker}</Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: c.foreground }]}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 54,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  buttonText: { fontFamily: font.semibold, fontSize: typography.size.control, letterSpacing: -0.1 },
  card: { borderWidth: 1, padding: spacing.xxl },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: radii.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    fontFamily: font.semibold,
    fontSize: typography.size.label,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: spacing.xl,
  },
  emptyTitle: {
    fontFamily: font.bold,
    fontSize: typography.size.title,
    letterSpacing: -0.6,
    marginTop: spacing.sm,
    lineHeight: typography.lineHeight.title,
  },
  body: {
    fontFamily: font.regular,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    marginTop: spacing.sm,
  },
  note: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    marginTop: spacing.xl,
    alignItems: 'flex-start',
  },
  noteText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typography.size.small,
    lineHeight: typography.lineHeight.small,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  sectionTitle: { fontFamily: font.bold, fontSize: typography.size.section, letterSpacing: -0.5, flexShrink: 1 },
  sectionHint: { fontFamily: font.medium, fontSize: typography.size.label },
  h1: {
    fontFamily: font.bold,
    fontSize: typography.size.display,
    letterSpacing: -1,
    lineHeight: typography.lineHeight.display,
  },
});
