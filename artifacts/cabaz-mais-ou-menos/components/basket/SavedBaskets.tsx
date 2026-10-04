import React, { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Button, font, SectionHeader } from '@/components/ui';
import { useBasket } from '@/context/BasketContext';
import { useColors } from '@/hooks/useColors';
import {
  addSavedBasket,
  createSavedBasket,
  deleteSavedBasketAfterConfirmation,
  EMPTY_SAVED_BASKETS_MESSAGE,
  loadSavedBaskets,
  MAX_SAVED_BASKET_NAME_LENGTH,
  renameSavedBasket as renameSavedBasketInStorage,
  restoreSavedBasket,
  type SavedBasket,
} from '@/lib/saved-baskets';

type SavedBasketsDialog =
  | { kind: 'save' }
  | { kind: 'rename'; basket: SavedBasket }
  | { kind: 'delete'; basket: SavedBasket };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatSavedDate(savedAt: string): string {
  return new Intl.DateTimeFormat('pt-PT', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(savedAt));
}

export function SavedBaskets() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { items, replaceBasket } = useBasket();
  const [savedBaskets, setSavedBaskets] = useState<SavedBasket[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [dialog, setDialog] = useState<SavedBasketsDialog | null>(null);
  const [name, setName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refreshSavedBaskets = useCallback(async () => {
    setIsLoading(true);
    try {
      setSavedBaskets(await loadSavedBaskets(AsyncStorage));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, 'Não foi possível ler os cabazes guardados.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSavedBaskets();
  }, [refreshSavedBaskets]);

  const saveBasket = useCallback(async () => {
    if (!items.length || isSaving) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const basket = createSavedBasket(name, items);
      const saved = await addSavedBasket(AsyncStorage, basket);
      setSavedBaskets(saved);
      setName('');
      setDialog(null);
      setMessage(`“${basket.name}” foi guardado neste dispositivo.`);
    } catch (cause) {
      setError(errorMessage(cause, 'Não foi possível guardar o cabaz neste dispositivo.'));
    } finally {
      setIsSaving(false);
    }
  }, [items, isSaving, name]);

  const renameBasket = useCallback(async () => {
    if (dialog?.kind !== 'rename' || isSaving) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await renameSavedBasketInStorage(AsyncStorage, dialog.basket.id, name);
      setSavedBaskets(saved);
      setName('');
      setDialog(null);
      setMessage(`O cabaz foi renomeado para “${name.trim()}”.`);
    } catch (cause) {
      setError(errorMessage(cause, 'Não foi possível renomear o cabaz neste dispositivo.'));
    } finally {
      setIsSaving(false);
    }
  }, [dialog, isSaving, name]);

  const deleteBasket = useCallback(async (basket: SavedBasket) => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await deleteSavedBasketAfterConfirmation(AsyncStorage, basket.id, true);
      setSavedBaskets(saved);
      setDialog(null);
      setMessage(`“${basket.name}” foi apagado.`);
    } catch (cause) {
      setError(errorMessage(cause, 'Não foi possível apagar o cabaz neste dispositivo.'));
    } finally {
      setIsSaving(false);
    }
  }, [isSaving]);

  const loadBasket = useCallback((basket: SavedBasket) => {
    try {
      replaceBasket(restoreSavedBasket(basket));
      setError(null);
      const hasGroupChoices = basket.products.some((product) => product.kind === 'group');
      setMessage(hasGroupChoices
        ? `“${basket.name}” carregado. A comparação de escolhas por grupo será ativada no próximo passo.`
        : `“${basket.name}” carregado. Os preços serão atualizados na próxima comparação.`);
    } catch (cause) {
      setError(errorMessage(cause, 'Não foi possível carregar este cabaz.'));
    }
  }, [replaceBasket]);

  return (
    <View style={styles.section}>
      <Button
        testID="button-guardar-cabaz"
        label="Guardar cabaz"
        icon="bookmark"
        disabled={items.length === 0 || isSaving}
        onPress={() => {
          setError(null);
          setMessage(null);
          setName('');
          setDialog({ kind: 'save' });
        }}
      />

      <View style={styles.list}>
        <SectionHeader title="Cabazes guardados" />
        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={c.primary} />
            <Text style={[styles.secondaryText, { color: c.mutedForeground }]}>A carregar cabazes guardados…</Text>
          </View>
        ) : savedBaskets.length === 0 ? (
          <Text style={[styles.secondaryText, { color: c.mutedForeground }]}>
            {EMPTY_SAVED_BASKETS_MESSAGE}
          </Text>
        ) : (
          savedBaskets.map((basket) => (
            <View
              key={basket.id}
              testID={`saved-basket-${basket.id}`}
              style={[styles.card, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius }]}
            >
              <View style={styles.cardHeading}>
                <View style={[styles.savedIcon, { backgroundColor: c.leafSoft }]}>
                  <Feather name="bookmark" size={17} color={c.primary} />
                </View>
                <View style={styles.cardDetails}>
                  <Text style={[styles.basketName, { color: c.foreground }]}>{basket.name}</Text>
                  <Text style={[styles.secondaryText, { color: c.mutedForeground }]}>
                    {basket.products.length} {
                      basket.products.some((product) => product.kind === 'group')
                        ? basket.products.length === 1 ? 'linha' : 'linhas'
                        : basket.products.length === 1 ? 'produto' : 'produtos'
                    }
                    {' · '}{formatSavedDate(basket.savedAt)}
                  </Text>
                </View>
              </View>
              <Button
                testID={`button-carregar-cabaz-${basket.id}`}
                variant="secondary"
                label="Carregar cabaz"
                icon="download"
                onPress={() => loadBasket(basket)}
              />
              <View style={styles.cardActions}>
                <Pressable
                  testID={`button-renomear-cabaz-${basket.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Renomear ${basket.name}`}
                  accessibilityState={{ disabled: isSaving }}
                  disabled={isSaving}
                  onPress={() => {
                    setError(null);
                    setMessage(null);
                    setName(basket.name);
                    setDialog({ kind: 'rename', basket });
                  }}
                  style={({ pressed }) => [
                    styles.inlineAction,
                    {
                      backgroundColor: c.muted,
                      borderColor: c.border,
                      borderRadius: c.radius - 4,
                      opacity: isSaving ? 0.5 : pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Feather name="edit-2" size={15} color={c.primary} />
                  <Text style={[styles.actionText, { color: c.primary }]}>Renomear</Text>
                </Pressable>
                <Pressable
                  testID={`button-pedir-apagar-cabaz-${basket.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Apagar ${basket.name}`}
                  accessibilityState={{ disabled: isSaving }}
                  disabled={isSaving}
                  onPress={() => {
                    setError(null);
                    setMessage(null);
                    setDialog({ kind: 'delete', basket });
                  }}
                  style={({ pressed }) => [
                    styles.inlineAction,
                    {
                      backgroundColor: c.muted,
                      borderColor: c.border,
                      borderRadius: c.radius - 4,
                      opacity: isSaving ? 0.5 : pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Feather name="trash-2" size={15} color={c.destructive} />
                  <Text style={[styles.actionText, { color: c.destructive }]}>Apagar</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
        {error ? (
          <View style={[styles.feedback, { backgroundColor: c.muted, borderRadius: c.radius - 4 }]}>
            <Text accessibilityRole="alert" style={[styles.feedbackText, { color: c.destructive }]}>{error}</Text>
            {!isLoading ? (
              <Pressable
                testID="button-recarregar-cabazes"
                accessibilityRole="button"
                onPress={() => void refreshSavedBaskets()}
              >
                <Text style={[styles.retry, { color: c.primary }]}>Tentar novamente</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {message ? (
          <Text accessibilityLiveRegion="polite" style={[styles.status, { color: c.primary }]}>{message}</Text>
        ) : null}
      </View>

      <Modal
        visible={dialog !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setDialog(null)}
        statusBarTranslucent
      >
        <KeyboardAvoidingView behavior="padding" style={[styles.modalBackdrop, {
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 20,
        }]}>
          <View style={[styles.modalCard, { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius + 4 }]}>
            {dialog?.kind === 'delete' ? (
              <>
                <Text accessibilityRole="header" style={[styles.modalTitle, { color: c.foreground }]}>
                  Queres apagar este cabaz?
                </Text>
                {error ? <Text accessibilityRole="alert" style={[styles.feedbackText, { color: c.destructive }]}>{error}</Text> : null}
                <View style={styles.modalActions}>
                  <Button
                    testID={`button-cancelar-apagar-cabaz-${dialog.basket.id}`}
                    variant="ghost"
                    label="Cancelar"
                    disabled={isSaving}
                    onPress={() => setDialog(null)}
                  />
                  <Pressable
                    testID={`button-confirmar-apagar-cabaz-${dialog.basket.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={isSaving ? 'A apagar cabaz' : 'Apagar'}
                    accessibilityState={{ disabled: isSaving }}
                    disabled={isSaving}
                    onPress={() => void deleteBasket(dialog.basket)}
                    style={({ pressed }) => [
                      styles.deleteConfirm,
                      {
                        backgroundColor: c.destructive,
                        borderRadius: c.radius,
                        opacity: isSaving ? 0.6 : pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.deleteConfirmText, { color: c.primaryForeground }]}>
                      {isSaving ? 'A apagar…' : 'Apagar'}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text accessibilityRole="header" style={[styles.modalTitle, { color: c.foreground }]}>
                  {dialog?.kind === 'rename' ? 'Renomear cabaz' : 'Guardar cabaz'}
                </Text>
                <Text style={[styles.secondaryText, { color: c.mutedForeground }]}>
                  {dialog?.kind === 'rename'
                    ? 'Altera o nome deste cabaz. Os produtos e quantidades serão mantidos.'
                    : 'Escolhe um nome para recuperares este cabaz mais tarde.'}
                </Text>
                <TextInput
                  testID={dialog?.kind === 'rename' ? 'input-renomear-cabaz' : 'input-nome-cabaz-guardado'}
                  accessibilityLabel="Nome do cabaz"
                  value={name}
                  onChangeText={setName}
                  onSubmitEditing={() => {
                    if (dialog?.kind === 'rename') void renameBasket();
                    else if (dialog?.kind === 'save') void saveBasket();
                  }}
                  placeholder="Ex.: Compras da semana"
                  placeholderTextColor={c.mutedForeground}
                  maxLength={MAX_SAVED_BASKET_NAME_LENGTH}
                  returnKeyType="done"
                  autoCapitalize="sentences"
                  autoCorrect
                  style={[styles.nameInput, {
                    backgroundColor: c.background,
                    borderColor: c.border,
                    borderRadius: c.radius - 4,
                    color: c.foreground,
                  }]}
                />
                {error ? <Text accessibilityRole="alert" style={[styles.feedbackText, { color: c.destructive }]}>{error}</Text> : null}
                <View style={styles.modalActions}>
                  <Button
                    testID={dialog?.kind === 'rename' ? 'button-cancelar-renomear-cabaz' : 'button-cancelar-guardar-cabaz'}
                    variant="ghost"
                    label="Cancelar"
                    disabled={isSaving}
                    onPress={() => setDialog(null)}
                  />
                  <Button
                    testID={dialog?.kind === 'rename' ? 'button-confirmar-renomear-cabaz' : 'button-confirmar-guardar-cabaz'}
                    label={isSaving ? 'A guardar…' : dialog?.kind === 'rename' ? 'Guardar nome' : 'Guardar cabaz'}
                    icon={isSaving ? undefined : 'check'}
                    disabled={!name.trim() || isSaving}
                    onPress={() => {
                      if (dialog?.kind === 'rename') void renameBasket();
                      else if (dialog?.kind === 'save') void saveBasket();
                    }}
                  />
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 18 },
  list: { gap: 10 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  card: { borderWidth: 1, padding: 14, gap: 12 },
  cardHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  savedIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardDetails: { flex: 1, gap: 3 },
  cardActions: { flexDirection: 'row', gap: 8 },
  inlineAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  actionText: { fontFamily: font.semibold, fontSize: 13 },
  basketName: { fontFamily: font.semibold, fontSize: 16 },
  secondaryText: { fontFamily: font.regular, fontSize: 13, lineHeight: 19 },
  feedback: { padding: 12, gap: 8 },
  feedbackText: { fontFamily: font.medium, fontSize: 13, lineHeight: 19 },
  retry: { fontFamily: font.semibold, fontSize: 14, minHeight: 36, textAlignVertical: 'center' },
  status: { fontFamily: font.medium, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 20 },
  modalCard: { width: '100%', maxWidth: 460, alignSelf: 'center', borderWidth: 1, padding: 20, gap: 14 },
  modalTitle: { fontFamily: font.bold, fontSize: 21 },
  nameInput: { minHeight: 50, borderWidth: 1, paddingHorizontal: 14, fontFamily: font.regular, fontSize: 16 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  deleteConfirm: { minHeight: 48, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  deleteConfirmText: { fontFamily: font.semibold, fontSize: 15 },
});