import locationData from '../data/portugal-locations.json';

export interface LocationOption {
  id: string;
  name: string;
}

export interface Municipality extends LocationOption {
  parishes: LocationOption[];
}

export interface District extends LocationOption {
  municipalities: Municipality[];
}

export interface ShoppingLocation {
  districtId: string;
  municipalityId: string;
  parishId: string;
}

export const DISTRICTS: readonly District[] = locationData;
export const LOCATION_STORAGE_KEY = 'cabaz-mais-ou-menos:shopping-location:v1';

export function resolveLocation(selection: ShoppingLocation | null) {
  if (!selection) return null;
  const district = DISTRICTS.find((item) => item.id === selection.districtId);
  const municipality = district?.municipalities.find(
    (item) => item.id === selection.municipalityId,
  );
  const parish = municipality?.parishes.find((item) => item.id === selection.parishId);
  return district && municipality && parish ? { district, municipality, parish } : null;
}

export function isValidLocation(value: unknown): value is ShoppingLocation {
  if (!value || typeof value !== 'object') return false;
  const selection = value as Record<string, unknown>;
  if (
    typeof selection.districtId !== 'string' ||
    typeof selection.municipalityId !== 'string' ||
    typeof selection.parishId !== 'string'
  ) {
    return false;
  }
  return !!resolveLocation({
    districtId: selection.districtId,
    municipalityId: selection.municipalityId,
    parishId: selection.parishId,
  });
}

export function serializeLocation(selection: ShoppingLocation): string {
  if (!isValidLocation(selection)) throw new Error('Escolhe uma zona completa e válida.');
  return JSON.stringify({
    version: 1,
    districtId: selection.districtId,
    municipalityId: selection.municipalityId,
    parishId: selection.parishId,
  });
}

export function deserializeLocation(value: string): ShoppingLocation {
  const stored: unknown = JSON.parse(value);
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('version' in stored) ||
    stored.version !== 1 ||
    !isValidLocation(stored)
  ) {
    throw new Error('A zona guardada já não é válida. Escolhe e guarda a tua zona novamente.');
  }
  return {
    districtId: stored.districtId,
    municipalityId: stored.municipalityId,
    parishId: stored.parishId,
  };
}