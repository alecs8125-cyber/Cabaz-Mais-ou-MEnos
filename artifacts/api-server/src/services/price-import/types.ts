export interface ExternalPriceObservation {
  readonly sourceType: string;
  readonly externalId: string;
  readonly sourceReference?: string | null;
  readonly barcode: string;
  readonly storeSourceType: string;
  readonly externalStoreId: string | null;
  readonly storeMappingUnverified?: boolean;
  readonly sourceStoreOsmType?: string | null;
  readonly sourceStoreOsmId?: string | null;
  readonly price: string | number;
  readonly currency: string;
  readonly promotion?: string | null;
  readonly priceIsDiscounted?: boolean | null;
  readonly priceWithoutDiscount?: string | number | null;
  readonly capturedAt: string;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
}

export type PriceFreshnessBucket =
  | "0-3-days"
  | "4-7-days"
  | "8-30-days"
  | "over-30-days";

export type ValidUntilOrigin = "source" | "policy" | "missing";

export interface PriceImportSourceAdapter {
  readonly sourceType: string;
  readonly mode: "external" | "test";
  readonly requiresValidUntil: boolean;
  readonly validityWindowDays?: number | null;
  fetchObservations(): Promise<readonly ExternalPriceObservation[]>;
}

export interface ProductLookupCandidate {
  readonly id: string;
  readonly barcode: string;
  readonly active: boolean;
}

export interface StoreMappingCandidate {
  readonly storeId: string;
  readonly sourceType: string;
  readonly externalStoreId: string;
  readonly active: boolean;
}

/** Read-only ports. There are deliberately no price or history write methods. */
export interface PriceImportLookup {
  findActiveProductsByExactBarcode(
    barcode: string,
  ): Promise<readonly ProductLookupCandidate[]>;
  findStoresByExternalId(
    sourceType: string,
    externalStoreId: string,
  ): Promise<readonly StoreMappingCandidate[]>;
}

export type PriceImportStatus = "ready" | "pending" | "rejected";

export interface PriceImportDryRunItem {
  readonly sourceType: string;
  readonly externalId: string | null;
  readonly sourceReference: string | null;
  readonly barcode: string | null;
  readonly storeSourceType: string | null;
  readonly externalStoreId: string | null;
  readonly storeMappingUnverified: boolean;
  readonly sourceStoreOsmType: string | null;
  readonly sourceStoreOsmId: string | null;
  readonly priceCents: number | null;
  readonly currency: string | null;
  readonly promotion: string | null;
  readonly priceIsDiscounted: boolean | null;
  readonly priceWithoutDiscount: string | number | null;
  readonly capturedAt: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly validUntilMissing: boolean;
  readonly validUntilOrigin: ValidUntilOrigin;
  readonly freshnessBucket: PriceFreshnessBucket | null;
  readonly isCurrent: boolean | null;
  readonly status: PriceImportStatus;
  readonly reasons: readonly string[];
  readonly testOnly: boolean;
  readonly productId?: string;
  readonly storeId?: string;
}

export interface PriceImportDryRunReport {
  readonly mode: "dry-run";
  readonly sourceType: string;
  readonly sourceMode: "external" | "test";
  readonly writesEnabled: false;
  readonly counts: Readonly<Record<PriceImportStatus, number>>;
  readonly items: readonly PriceImportDryRunItem[];
}