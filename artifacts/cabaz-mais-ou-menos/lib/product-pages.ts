export function mergeUniqueProductPages<T extends { readonly id: string }>(
  pages: readonly { readonly products: readonly T[] }[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];

  for (const page of pages) {
    for (const product of page.products) {
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      merged.push(product);
    }
  }

  return merged;
}