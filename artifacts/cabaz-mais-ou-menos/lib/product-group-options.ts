import type { ProductGroup, ProductGroupMember } from './product-types';

export type ProductGroupBrandOption =
  | { readonly kind: 'any'; readonly value: null; readonly label: 'Qualquer marca' }
  | { readonly kind: 'brand'; readonly value: string; readonly label: string };

export interface ProductGroupSelection {
  readonly kind: 'group';
  readonly groupId: string;
  readonly brand: string | null;
}

function comparePortuguese(a: string, b: string): number {
  return a.localeCompare(b, 'pt-PT');
}

export function normalizeProductGroupBrand(brand: string | null | undefined): string | null {
  const trimmed = brand?.trim();
  return trimmed ? trimmed.toLocaleLowerCase('pt-PT') : null;
}

export function getProductGroupCandidatesForBrand(
  members: readonly ProductGroupMember[],
  brand: string | null,
): ProductGroupMember[] {
  const normalizedBrand = normalizeProductGroupBrand(brand);
  if (normalizedBrand === null) return [...members];
  return members.filter(
    (member) => normalizeProductGroupBrand(member.brand) === normalizedBrand,
  );
}

export function getProductTypes(groups: readonly ProductGroup[]): string[] {
  return [...new Set(groups.map((group) => group.productType))]
    .sort(comparePortuguese);
}

export function getProductVariants(
  groups: readonly ProductGroup[],
  productType: string,
): string[] {
  return [...new Set(
    groups
      .filter((group) => group.productType === productType)
      .map((group) => group.variant),
  )].sort(comparePortuguese);
}

export function getGroupsForVariant(
  groups: readonly ProductGroup[],
  productType: string,
  variant: string,
): ProductGroup[] {
  return groups
    .filter((group) => group.productType === productType && group.variant === variant)
    .sort((a, b) =>
      a.packageQuantity - b.packageQuantity ||
      comparePortuguese(a.packageUnit, b.packageUnit) ||
      comparePortuguese(a.name, b.name) ||
      comparePortuguese(a.id, b.id),
    );
}

export function formatProductGroupPackage(group: ProductGroup): string {
  const quantity = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 3 })
    .format(group.packageQuantity);
  const rawUnit = group.packageUnit.trim();
  const unit = rawUnit.toLocaleLowerCase('pt-PT') === 'l' ? 'L' : rawUnit;
  return `${quantity} ${unit}`;
}

export function getProductGroupBrandOptions(
  members: readonly ProductGroupMember[],
): ProductGroupBrandOption[] {
  const brandsByNormalizedValue = new Map<string, string>();
  for (const member of members) {
    const label = member.brand?.trim();
    if (!label) continue;
    const value = normalizeProductGroupBrand(label)!;
    if (!brandsByNormalizedValue.has(value)) brandsByNormalizedValue.set(value, label);
  }

  const brands = [...brandsByNormalizedValue.entries()]
    .map(([value, label]) => ({ kind: 'brand' as const, value, label }))
    .sort((a, b) => comparePortuguese(a.label, b.label) || comparePortuguese(a.value, b.value));

  return [
    { kind: 'any', value: null, label: 'Qualquer marca' },
    ...brands,
  ];
}

export function createProductGroupSelection(
  groupId: string,
  option: ProductGroupBrandOption,
): ProductGroupSelection {
  if (!groupId.trim()) throw new Error('O grupo selecionado é inválido.');
  return {
    kind: 'group',
    groupId,
    brand: option.value,
  };
}