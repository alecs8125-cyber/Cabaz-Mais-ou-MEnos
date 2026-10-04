export type ContinenteMatchLevel =
  | "exact"
  | "high_confidence"
  | "ambiguous"
  | "unmatched";

export type ContinenteMatchMethod =
  | "verified_external_mapping"
  | "barcode_exact"
  | "name_brand_exact_unique"
  | null;

export interface ContinenteProductObservation {
  readonly sourceType: "continente";
  readonly externalProductId: string | null;
  readonly externalProductIdReason: string | null;
  readonly sourceReference: string;
  readonly name: string | null;
  readonly brand: string | null;
  readonly barcode: string | null;
  readonly sku: string | null;
  readonly mpn: string | null;
  readonly urlProductId: string | null;
  readonly price: string | null;
  readonly currency: "EUR" | null;
  readonly promotion: string | null;
  readonly regularPrice: string | null;
  readonly packageQuantity: number | null;
  readonly packageUnit: string | null;
  readonly availability: string | null;
  readonly image: string | null;
  readonly pricePerUnit: string | null;
  readonly capturedAt: string;
  readonly priceScope: "online";
}

export type ContinentePageOutcome =
  | "product"
  | "redirect"
  | "http_error"
  | "invalid_page"
  | "blocked"
  | "network_error";

export interface ContinentePageAttempt {
  readonly url: string;
  readonly outcome: ContinentePageOutcome;
  readonly status: number | null;
  readonly redirectLocation: string | null;
  readonly observation: ContinenteProductObservation | null;
  readonly error: string | null;
}

export interface ContinenteIdStability {
  readonly target: number;
  readonly attempted: number;
  readonly stable: number;
  readonly changed: number;
  readonly failed: number;
  readonly details: readonly {
    readonly url: string;
    readonly firstExternalProductId: string;
    readonly secondExternalProductId: string | null;
    readonly stable: boolean;
  }[];
}

export interface ContinenteAdapterAudit {
  readonly robotsUrl: string;
  readonly robotsAllowsProductPages: boolean;
  readonly sitemapIndexUrl: string;
  readonly productSitemaps: readonly string[];
  readonly productSitemapsRead: number;
  readonly productUrlsScanned: number;
  readonly startOffset: number;
  readonly sampledSitemapUrl: string | null;
  readonly sampledProductUrls: readonly string[];
  readonly firstPassAttempts: readonly ContinentePageAttempt[];
  readonly stability: ContinenteIdStability;
  readonly stoppedReason: string | null;
  readonly productPageRequests: number;
  readonly retries: number;
}

export interface ContinenteCatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly barcode: string | null;
  readonly unit: string | null;
  readonly active: boolean;
}

export interface ContinenteExternalProductMapping {
  readonly sourceType: string;
  readonly externalProductId: string;
  readonly productId: string;
  readonly matchMethod: string;
  readonly confidence: number;
  readonly verified: boolean;
}

export interface ContinenteMappingRepository {
  /** Read-only contract for a future mapping table; no table is queried yet. */
  findMappings(
    sourceType: string,
    externalProductId: string,
  ): Promise<readonly ContinenteExternalProductMapping[]>;
}

export interface ContinenteProductMatch {
  readonly level: ContinenteMatchLevel;
  readonly method: ContinenteMatchMethod;
  readonly confidence: number;
  readonly candidateCount: number;
  readonly product: ContinenteCatalogProduct | null;
  readonly explanation: string;
}

export interface ContinenteDryRunItem {
  readonly observation: ContinenteProductObservation;
  readonly match: ContinenteProductMatch;
  readonly priceUsableForProduct: boolean;
  readonly priceFeedableToCurrentStoreSchema: false;
}

export interface ContinenteDryRunReport {
  readonly mode: "dry-run";
  readonly sourceType: "continente";
  readonly priceScope: "online";
  readonly writesEnabled: false;
  readonly itemLimit: number;
  readonly catalogProductsLoaded: number;
  readonly audit: ContinenteAdapterAudit;
  readonly counts: Readonly<{
    pagesRequested: number;
    productPagesRequested: number;
    stabilityRereads: number;
    productsExtracted: number;
    pricesExtracted: number;
    validExternalIds: number;
    skuMpnEqual: number;
    urlIdMatches: number;
    duplicateExternalIds: number;
    productsWithoutId: number;
    formatsExtracted: number;
    promotionsFound: number;
    barcodesFound: number;
    exact: number;
    highConfidence: number;
    ambiguous: number;
    unmatched: number;
    pricesWithUsableProduct: number;
    pricesFeedableToCurrentSchema: 0;
    httpErrors: number;
    redirects: number;
    invalidPages: number;
  }>;
  readonly items: readonly ContinenteDryRunItem[];
}