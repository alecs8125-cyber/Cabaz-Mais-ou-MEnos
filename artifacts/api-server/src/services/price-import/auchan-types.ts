export type AuchanPriceScope =
  | "reference_only_2650_435"
  | "unknown";

export const AUCHAN_PRICE_FRESHNESS_MS = 36 * 60 * 60 * 1000;

export interface AuchanProductObservation {
  readonly sourceType: "auchan";
  readonly externalProductId: string | null;
  readonly externalProductIdReason: string | null;
  readonly sourceReference: string;
  readonly name: string;
  readonly brand: string | null;
  readonly barcode: string | null;
  readonly sku: string | null;
  readonly urlProductId: string | null;
  readonly price: string | null;
  readonly currency: "EUR" | null;
  readonly regularPrice: string | null;
  readonly promotion: string | null;
  readonly packageQuantity: number | null;
  readonly packageUnit: string | null;
  readonly availability: string | null;
  readonly image: string | null;
  readonly capturedAt: string;
  readonly priceScope: AuchanPriceScope;
  readonly priceScopeEvidence: boolean;
}

export interface AuchanParseResult {
  readonly observation: AuchanProductObservation | null;
  readonly invalidReason: string | null;
  readonly productSchemaFound: boolean;
}

export type AuchanPageOutcome =
  | "product"
  | "redirect"
  | "http_error"
  | "invalid_page"
  | "blocked"
  | "network_error"
  | "request_budget_exhausted";

export interface AuchanPageAttempt {
  readonly url: string;
  readonly outcome: AuchanPageOutcome;
  readonly status: number | null;
  readonly redirectLocation: string | null;
  readonly observation: AuchanProductObservation | null;
  readonly error: string | null;
}

export interface AuchanIdStability {
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

export interface AuchanAdapterAudit {
  readonly robotsUrl: string;
  readonly robotsAllowsProductPages: boolean;
  readonly sitemapIndexUrl: string;
  readonly productSitemaps: readonly string[];
  readonly productSitemapsRead: number;
  readonly productUrlsScanned: number;
  readonly startOffset: number;
  readonly sampledSitemapUrl: string | null;
  readonly sampledProductUrls: readonly string[];
  readonly firstPassAttempts: readonly AuchanPageAttempt[];
  readonly stability: AuchanIdStability;
  readonly stoppedReason: string | null;
  readonly productPageRequests: number;
}