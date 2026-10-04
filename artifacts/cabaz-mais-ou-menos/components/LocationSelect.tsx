import React, { useState } from 'react';
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { LocationOption } from '@/lib/locations';
import { font } from '@/components/ui';

interface LocationSelectProps {
  label: string;
  placeholder: string;
  options: readonly LocationOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  testID: string;
  disabled?: boolean;
}

export function LocationSelect({
  label,
  placeholder,
  options,
  selectedId,
  onSelect,
  testID,
  disabled = false,
}: LocationSelectProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const selected = options.find((item) => item.id === selectedId);
  const close = () => setIsOpen(false);

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.foreground }]}>{label}</Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selected?.name ?? placeholder }}
        accessibilityState={{ disabled, expanded: isOpen }}
        disabled={disabled}
        onPress={() => setIsOpen(true)}
        style={({ pressed }) => [
          styles.select,
          {
            backgroundColor: disabled ? c.muted : c.card,
            borderColor: selected ? c.primary : c.border,
            borderRadius: c.radius,
            opacity: pressed ? 0.75 : 1,
          },
        ]}
      >
        <Text style={[styles.value, { color: selected ? c.foreground : c.mutedForeground }]}>
          {selected?.name ?? placeholder}
        </Text>
        <Feather name="chevron-down" size={20} color={disabled ? c.mutedForeground : c.primary} />
      </Pressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="slide"
        onRequestClose={close}
        statusBarTranslucent
      >
        <View style={styles.overlay}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: c.foreground, opacity: 0.4 }]}
            onPress={close}
            accessible={false}
          />
          <View
            testID={`${testID}-dialog`}
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: c.card,
                paddingBottom: Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 16),
              },
            ]}
          >
            <View style={[styles.sheetHeader, { borderBottomColor: c.border }]}>
              <Text accessibilityRole="header" style={[styles.sheetTitle, { color: c.foreground }]}>
                Escolher {label.toLocaleLowerCase('pt-PT')}
              </Text>
              <Pressable
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel="Fechar seleção"
                onPress={close}
                style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Feather name="x" size={24} color={c.primary} />
              </Pressable>
            </View>
            <FlatList
              testID={`${testID}-options`}
              data={options}
              extraData={selectedId}
              keyExtractor={(item) => item.id}
              style={styles.options}
              contentContainerStyle={styles.optionsContent}
              initialNumToRender={20}
              renderItem={({ item }) => {
                const checked = item.id === selectedId;
                return (
                  <Pressable
                    testID={`${testID}-option-${item.id}`}
                    accessibilityRole="radio"
                    accessibilityLabel={item.name}
                    accessibilityState={{ checked }}
                    onPress={() => { onSelect(item.id); close(); }}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        borderBottomColor: c.border,
                        backgroundColor: checked ? c.leafSoft : c.card,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.optionText, { color: c.foreground }]}>{item.name}</Text>
                    {checked ? <Feather name="check" size={20} color={c.primary} /> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 9 },
  label: { fontFamily: font.semibold, fontSize: 15 },
  select: { minHeight: 58, paddingHorizontal: 16, paddingVertical: 15, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  value: { flex: 1, minWidth: 0, fontFamily: font.medium, fontSize: 16, lineHeight: 23 },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { height: '78%', width: '100%', maxWidth: 560, alignSelf: 'center', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 24, paddingRight: 10, paddingVertical: 12, borderBottomWidth: 1 },
  sheetTitle: { flex: 1, fontFamily: font.bold, fontSize: 20, lineHeight: 27 },
  close: { width: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  options: { flex: 1 },
  optionsContent: { paddingHorizontal: 12 },
  option: { minHeight: 54, paddingVertical: 15, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 12 },
  optionText: { flex: 1, fontFamily: font.medium, fontSize: 16, lineHeight: 23 },
});