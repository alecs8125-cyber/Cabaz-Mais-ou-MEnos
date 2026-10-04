import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deserializeLocation,
  LOCATION_STORAGE_KEY,
  resolveLocation,
  serializeLocation,
  ShoppingLocation,
} from '@/lib/locations';

interface ZoneContextValue {
  zone: string | null;
  location: ShoppingLocation | null;
  isLoading: boolean;
  restoreError: string | null;
  saveLocation: (location: ShoppingLocation) => Promise<void>;
}

const ZoneContext = createContext<ZoneContextValue | null>(null);

export function ZoneProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<ShoppingLocation | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function restoreLocation() {
      try {
        const stored = await AsyncStorage.getItem(LOCATION_STORAGE_KEY);
        const restored = stored === null ? null : deserializeLocation(stored);
        if (active) setLocation(restored);
      } catch {
        if (active) {
          setRestoreError('Não foi possível recuperar a zona guardada. Escolhe e guarda a tua zona novamente.');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    }
    void restoreLocation();
    return () => { active = false; };
  }, []);

  const saveLocation = useCallback(async (selection: ShoppingLocation) => {
    if (isLoading) throw new Error('Aguarda enquanto carregamos a zona guardada.');
    const serialized = serializeLocation(selection);
    try {
      // Só apresentar a nova zona depois de a escrita local terminar.
      await AsyncStorage.setItem(LOCATION_STORAGE_KEY, serialized);
    } catch {
      throw new Error('Não foi possível guardar a zona neste dispositivo. Tenta novamente.');
    }
    setLocation(deserializeLocation(serialized));
    setRestoreError(null);
  }, [isLoading]);

  const zone = resolveLocation(location)?.parish.name ?? null;
  const value = useMemo(
    () => ({ zone, location, isLoading, restoreError, saveLocation }),
    [zone, location, isLoading, restoreError, saveLocation],
  );
  return <ZoneContext.Provider value={value}>{children}</ZoneContext.Provider>;
}

export function useZone() {
  const ctx = useContext(ZoneContext);
  if (!ctx) throw new Error('useZone tem de ser usado dentro de ZoneProvider');
  return ctx;
}
