import type { DemoProduct } from '../data/demo-products';

export interface SupabaseProduct {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  // Optional for basket snapshots created before barcode was added to catalog queries.
  readonly barcode?: string | null;
  readonly category: string | null;
  readonly unit: string | null;
  readonly active: true;
  readonly isDemo: false;
  readonly demoPriceCents: null;
}

export interface ProductGroup {
  readonly id: string;
  readonly name: string;
  readonly productType: string;
  readonly variant: string;
  readonly packageQuantity: number;
  readonly packageUnit: string;
}

export interface ProductGroupBrandLabel {
  readonly groupId: string;
  readonly brand: string;
  readonly label: string;
}

export interface ProductGroupCatalogMetadata {
  readonly availableGroupIds: readonly string[];
  readonly brandLabels: readonly ProductGroupBrandLabel[];
}

export interface ProductGroupMember {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly barcode: string | null;
  readonly unit: string | null;
}

export type CatalogProduct = DemoProduct | SupabaseProduct;