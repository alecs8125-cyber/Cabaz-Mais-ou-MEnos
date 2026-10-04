import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button, font } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

export default function NotFoundScreen() {
  const c = useColors();
  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Text style={[styles.title, { color: c.foreground }]}>Este ecrã não existe.</Text>
      <Text style={[styles.text, { color: c.mutedForeground }]}>Volta ao início para continuar.</Text>
      <Button testID="button-not-found-inicio" label="Ir para o início" onPress={() => router.replace('/')} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.5 },
  text: { fontFamily: font.regular, fontSize: 15, marginBottom: 12 },
});
