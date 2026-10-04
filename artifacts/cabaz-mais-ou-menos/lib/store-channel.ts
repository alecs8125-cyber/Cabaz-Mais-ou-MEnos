/** Exact source identity only: a physical Continente store is never "online". */
export function isContinenteOnline(row: Readonly<Record<string, unknown>>): boolean {
  return row.source_type === 'continente' && row.external_id === 'online';
}