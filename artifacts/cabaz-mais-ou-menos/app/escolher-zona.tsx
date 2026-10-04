import React, { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, ScreenTitle, font } from '@/components/ui';
import { LocationSelect } from '@/components/LocationSelect';
import { useZone } from '@/context/ZoneContext';
import { useColors } from '@/hooks/useColors';
import { DISTRICTS, isValidLocation, ShoppingLocation } from '@/lib/locations';

export default function EscolherZonaScreen() {
  const c = useColors();
  const { location, isLoading } = useZone();

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
        <Text style={[styles.lead, { color: c.mutedForeground }]}>A carregar a tua zona...</Text>
      </View>
    );
  }

  return <LocationForm initialLocation={location} />;
}

function LocationForm({ initialLocation }: { initialLocation: ShoppingLocation | null }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const { saveLocation, restoreError } = useZone();
  const [districtId, setDistrictId] = useState<string | null>(initialLocation?.districtId ?? null);
  const [municipalityId, setMunicipalityId] = useState<string | null>(initialLocation?.municipalityId ?? null);
  const [parishId, setParishId] = useState<string | null>(initialLocation?.parishId ?? null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const district = DISTRICTS.find((item) => item.id === districtId);
  const municipalities = district?.municipalities ?? [];
  const municipality = municipalities.find((item) => item.id === municipalityId);
  const parishes = municipality?.parishes ?? [];
  const selected = { districtId, municipalityId, parishId };
  const canSave = isValidLocation(selected);

  const onSave = async () => {
    if (isSaving || !isValidLocation(selected)) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveLocation(selected);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível guardar a zona. Tenta novamente.');
      return;
    } finally {
      setIsSaving(false);
    }
    router.dismissTo(returnTo === 'home' ? '/' : '/cabaz');
  };

  return (
    <View testID="screen-escolher-zona" style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenTitle kicker="A tua zona" title="Onde costumas fazer compras?" />
        <Text style={[styles.lead, { color: c.mutedForeground }]}>
          Escolhe o distrito, o concelho e a freguesia. Podes alterar a zona quando quiseres.
        </Text>
        {restoreError ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: c.destructive }]}>{restoreError}</Text>
        ) : null}

        <View style={styles.fields}>
          <LocationSelect
            label="Distrito"
            placeholder="Selecionar distrito"
            testID="select-district"
            options={DISTRICTS}
            selectedId={districtId}
            disabled={isSaving}
            onSelect={(id) => {
              if (id === districtId) return;
              setDistrictId(id);
              setMunicipalityId(null);
              setParishId(null);
              setSaveError(null);
            }}
          />
          <LocationSelect
            label="Concelho"
            placeholder={district ? 'Selecionar concelho' : 'Escolhe primeiro o distrito'}
            testID="select-municipality"
            options={municipalities}
            selectedId={municipalityId}
            disabled={!district || isSaving}
            onSelect={(id) => {
              if (id === municipalityId) return;
              setMunicipalityId(id);
              setParishId(null);
              setSaveError(null);
            }}
          />
          <LocationSelect
            label="Freguesia"
            placeholder={municipality ? 'Selecionar freguesia' : 'Escolhe primeiro o concelho'}
            testID="select-parish"
            options={parishes}
            selectedId={parishId}
            disabled={!municipality || isSaving}
            onSelect={(id) => { setParishId(id); setSaveError(null); }}
          />
        </View>

        <View style={[styles.privacy, { backgroundColor: c.leafSoft, borderRadius: c.radius }]}>
          <Feather name="shield" size={20} color={c.primary} />
          <Text style={[styles.privacyText, { color: c.primary }]}>
            A escolha fica apenas neste dispositivo. Não usamos GPS nem pedimos acesso à localização.
          </Text>
        </View>
        <Text style={[styles.source, { color: c.mutedForeground }]}>
          Dados: DGT / INE · CAOP 2025 · CC BY 4.0.
        </Text>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 16), borderTopColor: c.border, backgroundColor: c.background }]}>
        {saveError ? (
          <Text testID="location-save-error" accessibilityRole="alert" style={[styles.error, { color: c.destructive }]}>
            {saveError}
          </Text>
        ) : null}
        <Button
          testID="button-guardar-zona"
          label={isSaving ? 'A guardar...' : 'Guardar zona'}
          icon="check"
          disabled={!canSave || isSaving}
          onPress={() => { void onSave(); }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  content: { padding: 24, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
  lead: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  fields: { gap: 22, marginTop: 14 },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, marginTop: 12 },
  privacyText: { flex: 1, fontFamily: font.medium, fontSize: 13, lineHeight: 20 },
  source: { fontFamily: font.regular, fontSize: 11, lineHeight: 17 },
  error: { fontFamily: font.medium, fontSize: 14, lineHeight: 21 },
  footer: { paddingHorizontal: 24, paddingTop: 16, borderTopWidth: 1, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
});
