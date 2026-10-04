import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

// O Expo só disponibiliza estas variáveis com acesso direto por process.env.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl) {
  throw new Error('Supabase não configurado: falta EXPO_PUBLIC_SUPABASE_URL.');
}

if (!supabasePublishableKey) {
  throw new Error(
    'Supabase não configurado: falta EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
  );
}

if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey)) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY deve ser uma chave publicável sb_publishable_. Não são permitidas chaves service_role ou sb_secret.',
  );
}

try {
  const url = new URL(supabaseUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('URL inválida');
  }
} catch {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL inválida: utiliza a URL HTTP/HTTPS do projeto Supabase, sem credenciais ou parâmetros.',
  );
}

// Cliente reutilizável, sem login, persistência de sessão ou renovação de tokens.
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  db: { schema: 'public' },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});