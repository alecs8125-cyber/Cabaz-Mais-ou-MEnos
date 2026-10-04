/** Exact source identity only: a physical Continente store is never "online". */
export function isContinenteOnline(row: Readonly<Record<string, unknown>>): boolean {
  return row.source_type === 'continente' && row.external_id === 'online';
}

export const AUCHAN_REFERENCE_STORE_LABEL =
  'Auchan Online · referência 2650-435 (Amadora)';
export const AUCHAN_REFERENCE_SCOPE_NOTE =
  'Preço de referência para entregas e recolhas no código postal 2650-435 (Amadora). Pode não corresponder ao preço aplicável ao teu código postal nem a uma loja física.';

export interface ManualStoreLocation {
  readonly district?: string | null;
  readonly municipality?: string | null;
  readonly parish?: string | null;
}

function normalizeLocation(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-PT');
}

/** The regional reference is compatible only with an explicit Lisboa/Amadora selection. */
export function isAuchanReferenceLocation(
  selection: ManualStoreLocation | null,
): boolean {
  return normalizeLocation(selection?.district) === 'lisboa' &&
    normalizeLocation(selection?.municipality) === 'amadora';
}

/** Exact regional-store identity; it must never be treated as a physical supermarket. */
export function isAuchanRegionalReference(
  row: Readonly<Record<string, unknown>>,
): boolean {
  return row.source_type === 'auchan' &&
    row.external_id === 'reference:2650-435' &&
    row.store_type === 'online_reference' &&
    row.postal_code === '2650-435' &&
    normalizeLocation(typeof row.district === 'string' ? row.district : null) === 'lisboa' &&
    normalizeLocation(typeof row.municipality === 'string' ? row.municipality : null) === 'amadora';
}