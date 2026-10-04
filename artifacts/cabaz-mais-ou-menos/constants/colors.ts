import { Platform } from 'react-native';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  base: 18,
  xl: 20,
  card: 24,
  pill: 999,
} as const;

export const typography = {
  family: {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
  },
  size: {
    caption: 11,
    label: 12,
    small: 13,
    body: 15,
    control: 16,
    section: 20,
    title: 24,
    headline: 28,
    display: 32,
  },
  lineHeight: {
    compact: 17,
    small: 19,
    body: 23,
    bodyLarge: 24,
    title: 30,
    display: 38,
    headline: 40,
  },
} as const;

export const shadows = {
  soft: Platform.select({
    web: {
      boxShadow: '0 2px 8px rgba(17, 24, 39, 0.06)',
    },
    default: {
      shadowColor: '#111827',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
  }) ?? {},
};

const colors = {
  light: {
    text: '#374151',
    tint: '#16A34A',

    background: '#F8FAF6',
    foreground: '#374151',

    card: '#FFFFFF',
    cardForeground: '#374151',

    primary: '#16A34A',
    primaryForeground: '#FFFFFF',

    secondary: '#22C55E',
    secondaryForeground: '#052E16',

    muted: '#F1F5F1',
    mutedForeground: '#6B7280',

    accent: '#F97316',
    accentForeground: '#431407',

    tomato: '#C2410C',
    leafSoft: '#DCFCE7',

    destructive: '#B91C1C',
    destructiveForeground: '#FFFFFF',

    border: '#E5E7EB',
    input: '#D1D5DB',
  },
  radius: radii.base,
  radii,
  spacing,
  typography,
  shadows,
};

export default colors;
